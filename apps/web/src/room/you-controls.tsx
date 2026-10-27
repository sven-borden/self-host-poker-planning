import { cleanName, MAX_NAME_LENGTH, MAX_PARTICIPANTS, type Role } from "@pp/domain";
import type { ParticipantView } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { type CommandResult, commandSender, sendCommand } from "../realtime/room-connection.ts";
import { Avatar, type AvatarLook } from "../table/avatar.tsx";
import { codeOf, failureMessage } from "./failure.ts";
import { NAME_INPUT_MAX_UNITS } from "./join-form.tsx";
import { saveName } from "./save-name.ts";

type Action = "rename" | "role" | "leave";

interface YouControlsProps {
  /** The viewer as the snapshot lists them. */
  me: ParticipantView;
  /** The look the table gave the viewer, so the panel and the seat match. */
  look?: AvatarLook | undefined;
  /** Moves the focus to this panel's heading (after joining), then calls `onFocused`. */
  focusOnMount?: boolean;
  onFocused?: () => void;
  /** Called just before `leave` is sent, and with false when it was refused. */
  onLeaving: (leaving: boolean) => void;
  /** False for a PO at the table in a room where the PO does not vote (`poVotes` off). */
  votes?: boolean;
}

/**
 * The viewer's own place in the room (#16): their name and role, and the three things
 * they can change from the room. Rename saves the name on the user too, so the next room
 * prefills it; switching role sends `setRole`; leaving sends `leave`, after which the
 * snapshot no longer holds `you` and the page shows the join form again.
 */
export function YouControls({
  me,
  look,
  focusOnMount,
  onFocused,
  onLeaving,
  votes = true,
}: YouControlsProps) {
  const t = useT();
  const ids = { heading: useId(), name: useId(), hint: useId(), error: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(me.name);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<{ message: string; nameRefused: boolean } | null>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    heading.current?.focus();
    onFocused?.();
  }, [focusOnMount, onFocused]);

  useEffect(() => {
    if (editing) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [editing]);

  function refuse(code: string) {
    const nameRefused = code === "bad_name";
    // Only a switch to voter meets `room_full` here: the seats are taken, not the room.
    const message =
      code === "room_full"
        ? t("you.seatsFull", { max: MAX_PARTICIPANTS })
        : failureMessage(t, code);
    setFailure({ message, nameRefused });
    if (nameRefused) nameInput.current?.focus();
  }

  /** Runs one command; a refusal shows its message. Returns whether it went through. */
  async function run(action: Action, send: () => Promise<CommandResult>): Promise<boolean> {
    // The buttons stay focusable while busy (aria-disabled), so a second press lands here.
    if (busy) return false;
    setBusy(action);
    setFailure(null);
    try {
      const ack = await send();
      if (!ack.ok) refuse(ack.code);
      return ack.ok;
    } catch (error) {
      refuse(codeOf(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  function startEditing() {
    setFailure(null);
    setDraft(me.name);
    setEditing(true);
  }

  function stopEditing() {
    setEditing(false);
    setFailure(null);
    // The rename button comes back in the next render; give it the focus then.
    requestAnimationFrame(() => renameButton.current?.focus());
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleaned = cleanName(draft);
    if (cleaned === null) {
      setFailure(null);
      refuse("bad_name");
      return;
    }
    if (cleaned === me.name) {
      stopEditing();
      return;
    }
    // Bound now: the rename goes to this room or nowhere, whatever the save takes.
    const send = commandSender();
    const done = await run("rename", async () =>
      send({ type: "rename", payload: { name: await saveName(cleaned) } }),
    );
    if (done) stopEditing();
  }

  function onEditorKey(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      stopEditing();
    }
  }

  const other: Role = me.role === "voter" ? "observer" : "voter";

  async function leave() {
    if (busy) return;
    onLeaving(true);
    const left = await run("leave", async () => {
      const ack = await sendCommand({ type: "leave" });
      // Another tab of this browser left first: the outcome is the same.
      return !ack.ok && ack.code === "not_participant" ? { ok: true, version: 0 } : ack;
    });
    if (!left) onLeaving(false);
  }

  const busyClass = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

  return (
    <section
      aria-labelledby={ids.heading}
      data-you
      className="rounded-xl border border-line bg-surface p-4 sm:p-5"
    >
      <h2
        id={ids.heading}
        ref={heading}
        tabIndex={-1}
        className="font-mono text-xs tracking-[0.08em] text-ink-2 uppercase"
      >
        {t("you.title")}
      </h2>
      {editing ? (
        <form
          className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={rename}
          onKeyDown={onEditorKey}
          noValidate
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label htmlFor={ids.name} className="font-medium">
              {t("seat.nameLabel")}
            </label>
            <Input
              ref={nameInput}
              id={ids.name}
              name="name"
              maxLength={NAME_INPUT_MAX_UNITS}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="nickname"
              enterKeyHint="done"
              aria-invalid={failure?.nameRefused || undefined}
              aria-describedby={failure?.nameRefused ? `${ids.error} ${ids.hint}` : ids.hint}
            />
            <p id={ids.hint} className="text-sm text-ink-2">
              {t("seat.nameHint", { max: MAX_NAME_LENGTH })}
            </p>
          </div>
          <div className="flex gap-2 sm:mb-7">
            <Button type="submit" className={busyClass} aria-disabled={busy !== null || undefined}>
              {busy === "rename" ? t("you.saving") : t("you.save")}
            </Button>
            <Button type="button" variant="outline" onClick={stopEditing}>
              {t("you.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar id={me.id} name={me.name} size={36} look={look} />
            <div className="flex min-w-0 flex-col">
              <span data-you-name dir="auto" className="truncate font-semibold">
                <bdi>{me.name}</bdi>
              </span>
              <span data-you-role={me.role} className="text-sm text-ink-2">
                {me.role === "observer"
                  ? t("you.roleObserver")
                  : votes
                    ? t("you.roleVoter")
                    : t("you.roleNotVoting")}
              </span>
            </div>
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button ref={renameButton} variant="outline" onClick={startEditing}>
              {t("you.rename")}
            </Button>
            <Button
              variant="outline"
              className={busyClass}
              aria-disabled={busy !== null || undefined}
              onClick={() =>
                run("role", () => sendCommand({ type: "setRole", payload: { role: other } }))
              }
            >
              {other === "observer" ? t("you.toObserver") : t("you.toVoter")}
            </Button>
            <Button
              variant="outline"
              className={busyClass}
              aria-disabled={busy !== null || undefined}
              onClick={leave}
            >
              {busy === "leave" ? t("you.leaving") : t("you.leave")}
            </Button>
          </div>
        </div>
      )}
      {failure && (
        <p id={ids.error} role="alert" className="mt-3 flex items-start gap-2 text-sm">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {failure.message}
        </p>
      )}
    </section>
  );
}
