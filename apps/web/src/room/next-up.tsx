import type { RoomView } from "@pp/protocol";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { serverTime, useClockOffset } from "../realtime/server-clock.ts";
import { focusSoon } from "./focus.ts";
import { itemName } from "./subject.ts";
import { useDeadlinePing } from "./timer.tsx";
import { remainingMs, shownSeconds } from "./timer-view.ts";

/** The whole seconds left until `at` on the server's clock, kept up to date; null without one. */
function useSecondsTo(at: number | null): number | null {
  const offset = useClockOffset();
  const [, tick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new offset moves the next whole second.
  useEffect(() => {
    if (at === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const left = remainingMs(at, serverTime());
      if (left <= 0) return;
      timer = setTimeout(
        () => {
          tick((n) => n + 1);
          schedule();
        },
        (left % 1000 || 1000) + 2,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [at, offset]);
  return at === null ? null : shownSeconds(remainingMs(at, serverTime()));
}

/**
 * What the queue holds next, under the table after a reveal, for everyone (#52): "Next:
 * ABC-124". Nothing while the round is voting, when the team has the ticket on the table
 * to think about, and nothing without a queue, so such a room looks as it always did.
 *
 * When the room moves on by itself the line counts down, in plain text, and the PO can
 * stay on the round. The number changes silently: the live region said it once, when the
 * countdown began. The server starts the round; a page pings once past the deadline, in
 * case its timer was lost, as for the vote timer (#27). The button leaves when the countdown
 * ends, however it ends, and hands its focus on.
 */
export function NextUp({
  room,
  onFailure,
}: {
  room: RoomView;
  onFailure: (code: string | null) => void;
}) {
  const t = useT();
  const { queue, round } = room;
  const advanceAt = round?.phase === "revealed" ? (round.advanceAt ?? null) : null;
  const seconds = useSecondsTo(advanceAt);
  useDeadlinePing(advanceAt, (now) => now?.phase === "revealed" && now.advanceAt === advanceAt);
  const pending = useRef(false);
  const owner = room.you !== null && room.you === room.ownerId;
  const voting = useRef(false);
  voting.current = round?.phase === "voting";

  async function stay() {
    if (pending.current) return;
    pending.current = true;
    onFailure(null);
    try {
      const ack = await commandSender()({ type: "holdAdvance" });
      if (!ack.ok) onFailure(ack.code);
    } finally {
      pending.current = false;
    }
  }

  if (queue === undefined || round?.phase !== "revealed") return null;
  const item = itemName(queue.next);
  return (
    <p
      data-next-up
      className="m-0 mt-3 flex flex-wrap items-center justify-center gap-x-3 text-center text-sm text-ink-2"
    >
      <bdi className="min-w-0 break-words">
        {seconds === null ? t("queue.next", { item }) : t("queue.nextIn", { item, seconds })}
      </bdi>
      {owner && seconds !== null ? <StayButton voting={voting} onStay={() => void stay()} /> : null}
    </p>
  );
}

/**
 * "Stay on this round". It leaves when the countdown ends, however that ends, and its focus
 * would fall to the page: to the hand when the next item started, else back to the decision.
 * A layout cleanup runs while the button is still in the document.
 */
function StayButton({
  voting,
  onStay,
}: {
  /** Whether the round on the table votes by now: the next item started. */
  voting: RefObject<boolean>;
  onStay: () => void;
}) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = button.current;
    return () => {
      if (element === null || element !== document.activeElement) return;
      if (voting.current) focusSoon("[data-hand] [tabindex='0']", "[data-centre-status='voting']");
      else focusSoon("[data-record-final]", "[data-start-round]");
    };
  }, [voting]);
  return (
    <button
      ref={button}
      type="button"
      data-hold-advance
      onClick={onStay}
      className="min-h-8 rounded-md px-2 font-medium text-ink underline underline-offset-2 phone:min-h-11"
    >
      {t("queue.stay")}
    </button>
  );
}
