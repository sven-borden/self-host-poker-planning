import { LockIcon, OctagonXIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import { RoomApiError, removeRoomPassword, setRoomPassword } from "../rooms/api.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { codeOf, failureMessage } from "./failure.ts";
import { PasswordInput } from "./password-input.tsx";
import type { ControlProps } from "./settings-panel.tsx";

/** Where the focus goes once the row has changed under it. */
type FocusNext = "input" | "change" | null;

/**
 * The PO's "Password" row in "Room settings" (#31), a `block` control. Without a password:
 * the field (with "Show password") and "Set password". With one: "This room has a
 * password.", "Change password" (which opens the field, with "Cancel") and "Remove
 * password", which does not ask first. The password goes over HTTP (`setRoomPassword`),
 * never over the socket; the row follows the room's snapshot, so it changes once the
 * server has stored the change. A refusal (`bad_password`, `rate_limited`) shows under it.
 */
export function PasswordSetting({ settings, id, describedBy }: ControlProps) {
  const t = useT();
  const code = useRoomStore((state) => state.code);
  const has = settings.hasPassword === true;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState<FocusNext>(null);
  const input = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const open = !has || editing;

  // The focus follows the row once the snapshot has changed it: to the field after a
  // removal or "Change password", to "Change password" after a password was set.
  useEffect(() => {
    if (focusNext === "input" && open) {
      input.current?.focus();
      setFocusNext(null);
    } else if (focusNext === "change" && !open) {
      changeButton.current?.focus();
      setFocusNext(null);
    }
  }, [focusNext, open]);

  function refused(error: unknown) {
    const failed = error instanceof RoomApiError ? error.code : codeOf(error);
    setFailure(
      failed === "bad_password" || failed === "rate_limited"
        ? errorMessage(t, failed)
        : failureMessage(t, failed),
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || code === null) return;
    setFailure(null);
    setBusy(true);
    try {
      await setRoomPassword(code, value);
      setValue("");
      setEditing(false);
      setFocusNext("change");
    } catch (error) {
      refused(error);
      input.current?.focus();
      input.current?.select();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || code === null) return;
    setFailure(null);
    setBusy(true);
    try {
      await removeRoomPassword(code);
      setEditing(false);
      setFocusNext("input");
    } catch (error) {
      refused(error);
    } finally {
      setBusy(false);
    }
  }

  const described = [describedBy, failure !== null && errorId].filter(Boolean).join(" ");
  return (
    <div data-password-setting={open ? "field" : "set"}>
      {open ? (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-start" onSubmit={save} noValidate>
          <div className="min-w-0 flex-1">
            <PasswordInput
              ref={input}
              id={id}
              name="room-password"
              autoComplete="new-password"
              enterKeyHint="done"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby={described}
              aria-invalid={failure !== null || undefined}
            />
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="submit"
              aria-disabled={busy || undefined}
              className="aria-disabled:opacity-60"
            >
              {t("password.set")}
            </Button>
            {has ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setFailure(null);
                  setFocusNext("change");
                }}
              >
                {t("password.cancel")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <>
          {/* The field's id sits here, not on a button: a <label for> would rename it. */}
          <p id={id} role="status" className="m-0 flex items-center gap-2 font-medium">
            <LockIcon aria-hidden className="size-4 shrink-0 text-ink-2" />
            {t("password.roomHas")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              ref={changeButton}
              type="button"
              variant="outline"
              aria-describedby={described}
              onClick={() => {
                setFailure(null);
                setEditing(true);
                setFocusNext("input");
              }}
            >
              {t("password.change")}
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-disabled={busy || undefined}
              className="aria-disabled:opacity-60"
              onClick={remove}
            >
              {t("password.remove")}
            </Button>
          </div>
        </>
      )}
      {failure !== null ? (
        <p id={errorId} role="alert" className="m-0 mt-2 flex items-start gap-2 text-sm text-ink">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {failure}
        </p>
      ) : null}
    </div>
  );
}
