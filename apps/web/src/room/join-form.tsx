import {
  cleanName,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  type Role,
  UNITS_PER_CHARACTER,
} from "@pp/domain";
import { LockIcon, OctagonXIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { commandSender, enterRoomAgain } from "../realtime/room-connection.ts";
import { enterRoomPassword, RoomApiError } from "../rooms/api.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import type { LockReason } from "../stores/room-store.ts";
import { codeOf, failureMessage } from "./failure.ts";
import { PasswordInput } from "./password-input.tsx";
import { saveName } from "./save-name.ts";

/**
 * The name input takes as many code units as the domain accepts for 32 characters, so
 * the browser never cuts an emoji or an accented letter in half; `cleanName` counts the
 * characters. Only a paste far beyond any name is cut here.
 */
export const NAME_INPUT_MAX_UNITS = MAX_NAME_LENGTH * UNITS_PER_CHARACTER;

const ROLE_OPTIONS = [
  { role: "voter", label: "seat.voter", hint: "seat.voterHint" },
  { role: "observer", label: "seat.observer", hint: "seat.observerHint" },
] as const satisfies ReadonlyArray<{ role: Role; label: string; hint: string }>;

/** What went wrong, and which field it is about (that field gets the focus). */
type Failure = { message: string; field: "name" | "password" | null };

interface JoinFormProps {
  /** Whether observers take one of the 16 seats (the room's setting). */
  observersCount: boolean;
  /**
   * The room asks this viewer for its password (#31), and why: the form then shows a
   * "Password" field above the name, and "Join" checks it before entering.
   */
  password?: { code: string; reason: LockReason } | null;
  /**
   * Moves the focus to the name field (after leaving the room, or when a seat frees up),
   * or to the password field when there is one, then calls `onFocused`, so the request is
   * not replayed later.
   */
  focusOnMount?: boolean;
  onFocused?: () => void;
  /** Called just before `join` is sent, and with false when it was refused. */
  onJoining: (joining: boolean) => void;
  /** The server answered `room_full` for everyone: the page shows the room-full screen. */
  onFull: () => void;
}

/** "Too many tries. Try again in 3 minutes.": the wait in whole minutes, at least 1. */
function tooMany(t: ReturnType<typeof useT>, retryAfter: number | undefined): string {
  return t("password.tooMany", { count: Math.max(1, Math.ceil((retryAfter ?? 60) / 60)) });
}

/**
 * The join screen (#16): a display name, prefilled with the last one this browser used,
 * and voter or observer, voter by default. The PO joins the same way. Submitting checks
 * the name with the domain's `cleanName`, saves it on the user when it changed (`saveName`,
 * which never blocks the join), then sends `join` to the room that was on screen at the
 * submit. The page swaps the form for the table when the snapshot says `you`.
 *
 * In a room with a password (#31) the form asks for it first, above the name, with one
 * "Join" button: the password is checked over HTTP, the socket enters the room again,
 * then `join` goes as usual. A wrong one keeps the focus on the field, its text selected.
 */
export function JoinForm({
  observersCount,
  password,
  focusOnMount,
  onFocused,
  onJoining,
  onFull,
}: JoinFormProps) {
  const t = useT();
  const ids = {
    heading: useId(),
    name: useId(),
    hint: useId(),
    error: useId(),
    role: useId(),
    password: useId(),
    lock: useId(),
  };
  const savedName = useIdentityStore((state) => state.name);
  const [name, setName] = useState(savedName ?? "");
  const [edited, setEdited] = useState(false);
  const [role, setRole] = useState<Role>("voter");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const asked = password ?? null;

  // The saved name can arrive after the form (the identity bootstrap runs beside the page).
  useEffect(() => {
    if (!edited && savedName !== null) setName(savedName);
  }, [edited, savedName]);

  useEffect(() => {
    if (!focusOnMount) return;
    (passwordInput.current ?? nameInput.current)?.focus();
    onFocused?.();
  }, [focusOnMount, onFocused]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second submit lands here.
    if (busy) return;
    setFailure(null);
    // The domain's own rule, checked here: a refused name costs no request.
    const cleaned = cleanName(name);
    if (cleaned === null) {
      refuse("bad_name");
      return;
    }
    if (asked && secret === "") {
      show({ message: t("password.missing"), field: "password" });
      return;
    }
    setBusy(true);
    try {
      if (asked && !(await unlock(asked.code))) return;
      // The join goes to the room on screen now, or nowhere: the page may move to another
      // room while the name is being saved.
      const send = commandSender();
      const joinName = await saveName(cleaned);
      onJoining(true);
      const ack = await send({ type: "join", payload: { name: joinName, role } });
      // Joined, or another tab of this browser joined first: the snapshot holds `you`.
      if (ack.ok || ack.code === "already_joined") return;
      onJoining(false);
      if (ack.code === "password_required") {
        // The PO set a password since this page entered: the form asks for it.
        await enterRoomAgain();
      } else if (ack.code === "room_full" && (observersCount || role === "observer")) {
        onFull();
      } else {
        refuse(ack.code);
      }
    } catch (error) {
      onJoining(false);
      refuse(codeOf(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Checks the password, then enters the room again on the open socket. False, with the
   * reason shown, when either step failed.
   */
  async function unlock(code: string): Promise<boolean> {
    try {
      await enterRoomPassword(code, secret);
    } catch (error) {
      const failed = error instanceof RoomApiError ? error.code : codeOf(error);
      if (failed === "wrong_password") {
        show({ message: errorMessage(t, failed), field: "password" });
      } else if (failed === "rate_limited") {
        const wait = error instanceof RoomApiError ? error.retryAfter : undefined;
        show({ message: tooMany(t, wait), field: "password" });
      } else {
        show({ message: failureMessage(t, failed), field: null });
      }
      return false;
    }
    const entered = await enterRoomAgain();
    if (entered === "ok") return true;
    // Changed again between the check and the enter: the field asks for the new one.
    show({
      message: entered === "password_required" ? t("password.changed") : failureMessage(t, entered),
      field: entered === "password_required" ? "password" : null,
    });
    return false;
  }

  /** Shows what went wrong; the field at fault gets the focus, its text selected. */
  function show(next: Failure) {
    setFailure(next);
    if (next.field === "password") {
      passwordInput.current?.focus();
      passwordInput.current?.select();
    } else if (next.field === "name") {
      nameInput.current?.focus();
    }
  }

  function refuse(code: string) {
    // Only voters are refused when observers do not count: the seats are taken, not the room.
    const message =
      code === "room_full"
        ? t("seat.seatsFull", { max: MAX_PARTICIPANTS })
        : failureMessage(t, code);
    show({ message, field: code === "bad_name" ? "name" : null });
  }

  const nameRefused = failure?.field === "name";
  const passwordRefused = failure?.field === "password";
  const alert = failure ? (
    <p id={ids.error} role="alert" className="m-0 flex items-start gap-2 text-sm">
      <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
      {failure.message}
    </p>
  ) : null;

  return (
    <section
      aria-labelledby={ids.heading}
      data-join
      className="max-w-xl rounded-xl border border-line bg-surface p-5 sm:p-7"
    >
      <h2 id={ids.heading} className="text-2xl font-[760] [font-stretch:110%]">
        {t("seat.title")}
      </h2>
      <p className="mt-2 text-ink-2">{t("seat.lede")}</p>
      <form className="mt-6 flex flex-col gap-6" onSubmit={submit} noValidate>
        {asked ? (
          <div className="flex flex-col gap-2" data-join-password>
            <label htmlFor={ids.password} className="font-medium">
              {t("password.label")}
            </label>
            <PasswordInput
              ref={passwordInput}
              id={ids.password}
              name="password"
              autoComplete="current-password"
              enterKeyHint="go"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              aria-invalid={passwordRefused || undefined}
              aria-describedby={passwordRefused ? `${ids.error} ${ids.lock}` : ids.lock}
            />
            <p id={ids.lock} className="m-0 flex items-start gap-2 text-sm text-ink-2">
              <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {asked.reason === "changed"
                ? t("password.changed")
                : errorMessage(t, "password_required")}
            </p>
            {passwordRefused ? alert : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <label htmlFor={ids.name} className="font-medium">
            {t("seat.nameLabel")}
          </label>
          <Input
            ref={nameInput}
            id={ids.name}
            name="name"
            maxLength={NAME_INPUT_MAX_UNITS}
            value={name}
            onChange={(event) => {
              setEdited(true);
              setName(event.target.value);
            }}
            autoComplete="nickname"
            enterKeyHint="go"
            aria-invalid={nameRefused || undefined}
            aria-describedby={nameRefused ? `${ids.error} ${ids.hint}` : ids.hint}
          />
          <p id={ids.hint} className="text-sm text-ink-2">
            {t("seat.nameHint", { max: MAX_NAME_LENGTH })}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">{t("seat.roleLabel")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {ROLE_OPTIONS.map((option) => (
              <label
                key={option.role}
                data-role-option={option.role}
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line-strong px-3 py-2.5 transition-colors",
                  "hover:bg-surface-2 has-checked:border-spruce has-checked:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.role}
                  checked={role === option.role}
                  onChange={() => setRole(option.role)}
                  className="mt-1 size-4 shrink-0 accent-spruce"
                  aria-labelledby={`${ids.role}-${option.role}`}
                  aria-describedby={`${ids.role}-${option.role}-hint`}
                />
                <span className="flex min-w-0 flex-col">
                  <span id={`${ids.role}-${option.role}`} className="font-medium">
                    {t(option.label)}
                  </span>
                  <span id={`${ids.role}-${option.role}-hint`} className="text-sm text-ink-2">
                    {t(option.hint)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {/* A refused password is said under its field; anything else above the button. */}
        {failure && !passwordRefused ? alert : null}
        {/* aria-disabled, not disabled: a disabled button drops the focus to the page. */}
        <Button
          type="submit"
          size="lg"
          className="w-full sm:w-auto sm:self-start aria-disabled:pointer-events-none aria-disabled:opacity-50"
          aria-disabled={busy || undefined}
        >
          {busy ? t("seat.joining") : t("seat.submit")}
        </Button>
      </form>
    </section>
  );
}
