import {
  cleanName,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  type Role,
  UNITS_PER_CHARACTER,
} from "@pp/domain";
import { OctagonXIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { codeOf, failureMessage } from "./failure.ts";
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

interface JoinFormProps {
  /** Whether observers take one of the 16 seats (the room's setting). */
  observersCount: boolean;
  /**
   * Moves the focus to the name field (after leaving the room, or when a seat frees up),
   * then calls `onFocused`, so the request is not replayed later.
   */
  focusOnMount?: boolean;
  onFocused?: () => void;
  /** Called just before `join` is sent, and with false when it was refused. */
  onJoining: (joining: boolean) => void;
  /** The server answered `room_full` for everyone: the page shows the room-full screen. */
  onFull: () => void;
}

/**
 * The join screen (#16): a display name, prefilled with the last one this browser used,
 * and voter or observer, voter by default. The PO joins the same way. Submitting checks
 * the name with the domain's `cleanName`, saves it on the user when it changed (`saveName`,
 * which never blocks the join), then sends `join` to the room that was on screen at the
 * submit. The page swaps the form for the table when the snapshot says `you`.
 */
export function JoinForm({
  observersCount,
  focusOnMount,
  onFocused,
  onJoining,
  onFull,
}: JoinFormProps) {
  const t = useT();
  const ids = { heading: useId(), name: useId(), hint: useId(), error: useId(), role: useId() };
  const savedName = useIdentityStore((state) => state.name);
  const [name, setName] = useState(savedName ?? "");
  const [edited, setEdited] = useState(false);
  const [role, setRole] = useState<Role>("voter");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; nameRefused: boolean } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  // The saved name can arrive after the form (the identity bootstrap runs beside the page).
  useEffect(() => {
    if (!edited && savedName !== null) setName(savedName);
  }, [edited, savedName]);

  useEffect(() => {
    if (!focusOnMount) return;
    nameInput.current?.focus();
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
    // The join goes to the room on screen now, or nowhere: the page may move to another
    // room while the name is being saved.
    const send = commandSender();
    setBusy(true);
    try {
      const joinName = await saveName(cleaned);
      onJoining(true);
      const ack = await send({ type: "join", payload: { name: joinName, role } });
      // Joined, or another tab of this browser joined first: the snapshot holds `you`.
      if (ack.ok || ack.code === "already_joined") return;
      onJoining(false);
      if (ack.code === "room_full" && (observersCount || role === "observer")) onFull();
      else refuse(ack.code);
    } catch (error) {
      onJoining(false);
      refuse(codeOf(error));
    } finally {
      setBusy(false);
    }
  }

  /** Shows what went wrong; a refused name gets the focus, so it can be fixed at once. */
  function refuse(code: string) {
    const nameRefused = code === "bad_name";
    // Only voters are refused when observers do not count: the seats are taken, not the room.
    const message =
      code === "room_full"
        ? t("seat.seatsFull", { max: MAX_PARTICIPANTS })
        : failureMessage(t, code);
    setFailure({ message, nameRefused });
    if (nameRefused) nameInput.current?.focus();
  }

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
            aria-invalid={failure?.nameRefused || undefined}
            aria-describedby={failure?.nameRefused ? `${ids.error} ${ids.hint}` : ids.hint}
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
        {failure && (
          <p id={ids.error} role="alert" className="flex items-start gap-2 text-sm">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {failure.message}
          </p>
        )}
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
