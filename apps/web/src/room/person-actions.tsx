import type { ParticipantView, RoomView } from "@pp/protocol";
import { CrownIcon, OctagonXIcon, UserRoundXIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { type ActionTarget, shownName } from "../table/seat.tsx";
import { codeOf, failureMessage } from "./failure.ts";

type Action = "owner" | "remove";

interface PersonActionsProps {
  /** The person whose popover this is. */
  person: ActionTarget;
  room: RoomView;
  /** The viewer as the snapshot lists them. */
  me: ParticipantView;
  /** Closes the popover; the focus goes back to the person's button. */
  close: () => void;
}

/** Every person's button around the table and in the observers' row, in page order. */
const triggers = () => [
  ...document.querySelectorAll<HTMLElement>("[data-room-table] [data-person-trigger]"),
];

/**
 * After a removal the person's button is gone and the focus with it: it goes to the button
 * that took their place in the page's order (or the last one), once the table has drawn
 * the room without them, unless something else took the focus meanwhile.
 */
function focusAfterRemoval(id: string, index: number, frames = 10) {
  requestAnimationFrame(() => {
    const list = triggers();
    if (list.some((el) => el.dataset.personTrigger === id)) {
      if (frames > 0) focusAfterRemoval(id, index, frames - 1);
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    list[Math.min(Math.max(index, 0), list.length - 1)]?.focus({ preventScroll: true });
  });
}

/**
 * The PO's actions on someone else, in that person's popover (#30): "Make product owner"
 * (only for someone here: the server refuses an away target) and "Remove from the room".
 * Each asks first, inline, in a group that takes the focus and is named by the question;
 * "Cancel" gives the focus back to the action. The question says what the hand-over
 * means: the PO becomes a voter or stays an observer, and when the PO does not vote in
 * this room, a voter who takes over stops voting.
 *
 * Shown to the PO only. A hand-over makes the viewer someone else before its ack comes
 * back, so a question already sent stays until the answer: then the popover closes, or
 * the refusal shows under it.
 */
export function PersonActions({ person, room, me, close }: PersonActionsProps) {
  const t = useT();
  const ids = { question: useId(), note: useId() };
  const [asking, setAsking] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const ownerButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  /** The action whose question was cancelled: its button takes the focus back. */
  const back = useRef<Action | null>(null);

  // Only when the question comes or goes: a snapshot that re-renders the popover (someone
  // voted) must not pull the focus off "Hand over" back to the question.
  useLayoutEffect(() => {
    if (asking !== null) {
      group.current?.focus();
      return;
    }
    const action = back.current;
    back.current = null;
    if (action !== null) (action === "owner" ? ownerButton : removeButton).current?.focus();
  }, [asking]);

  if (!me.isOwner && !busy && failure === null) return null;
  const name = shownName(t, person);

  function ask(action: Action) {
    setFailure(null);
    setAsking(action);
  }

  function cancel() {
    back.current = asking;
    setAsking(null);
  }

  async function confirm() {
    if (busy || asking === null) return;
    const action = asking;
    const send = commandSender();
    const index = triggers().findIndex((el) => el.dataset.personTrigger === person.id);
    setBusy(true);
    setFailure(null);
    let code: string | null = null;
    try {
      const ack = await send(
        action === "owner"
          ? { type: "transferOwner", payload: { to: person.id } }
          : { type: "kick", payload: { who: person.id } },
      );
      // Removed by another tab of the PO, or gone on their own: the outcome is the same.
      if (!ack.ok && !(action === "remove" && ack.code === "unknown_participant")) code = ack.code;
    } catch (error) {
      code = codeOf(error);
    }
    setBusy(false);
    if (code !== null) {
      setFailure(failureMessage(t, code));
      return;
    }
    if (action === "remove") focusAfterRemoval(person.id, index);
    close();
  }

  const question =
    asking === "owner"
      ? t(me.role === "observer" ? "po.handOverObserver" : "po.handOverVoter", { name })
      : t("po.removeQuestion", { name });
  // The PO does not vote in this room: a voter who takes over puts their cards down.
  const note =
    asking === "owner" && !room.settings.poVotes && person.role === "voter"
      ? t("po.handOverNoVote", { name })
      : null;
  const compact = "h-9 phone:h-11";

  return (
    <div data-po-actions className="mt-2 border-t border-line pt-2">
      {asking === null ? (
        <div className="flex flex-col gap-1">
          {person.away ? null : (
            <Button
              ref={ownerButton}
              variant="ghost"
              size="sm"
              className={`${compact} justify-start`}
              onClick={() => ask("owner")}
            >
              <CrownIcon aria-hidden />
              {t("po.makeOwner")}
            </Button>
          )}
          <Button
            ref={removeButton}
            variant="ghost"
            size="sm"
            className={`${compact} justify-start`}
            onClick={() => ask("remove")}
          >
            <UserRoundXIcon aria-hidden />
            {t("po.remove")}
          </Button>
        </div>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, focused as one block, hold no form field to group
        <div
          ref={group}
          role="group"
          tabIndex={-1}
          aria-labelledby={ids.question}
          aria-describedby={note === null ? undefined : ids.note}
          data-po-question={asking}
          className="rounded-md border border-warn bg-surface-2 p-2.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <p id={ids.question} className="m-0 text-sm break-words">
            {question}
          </p>
          {note !== null ? (
            <p id={ids.note} className="m-0 mt-1 text-xs text-ink-2">
              {note}
            </p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={asking === "remove" ? "destructive" : "default"}
              className={`${compact} aria-disabled:pointer-events-none aria-disabled:opacity-50`}
              aria-disabled={busy || undefined}
              onClick={confirm}
            >
              {busy
                ? t(asking === "owner" ? "po.handingOver" : "po.removing")
                : t(asking === "owner" ? "po.handOver" : "po.removeConfirm")}
            </Button>
            <Button size="sm" variant="outline" className={compact} onClick={cancel}>
              {t("po.cancel")}
            </Button>
          </div>
        </div>
      )}
      {failure !== null ? (
        <p role="alert" className="m-0 mt-2 flex items-start gap-2 text-xs">
          <OctagonXIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-bad" />
          {failure}
        </p>
      ) : null}
    </div>
  );
}
