import type { QueueSummary } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import { type RefObject, useCallback, useId, useRef, useState } from "react";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { RoomQueueButton } from "./queue-button.tsx";
import { focusSoon } from "./round-centre.tsx";
import { draftSubject, itemName, problemMessage, type SubjectProblem } from "./subject.ts";

// The PO's next round (#21): a subject field above the table and the centre's button
// ("Start voting" in the lobby, "Next round" after a reveal). The field stays while a
// round is voting, so the PO can prepare the next ticket and the table never jumps; only
// the button starts a round, and a voting round has none (the domain would abandon it).
// With a queue (#52) an empty field means its next item, and anything typed wins: the
// queue never locks the PO out of the field, and a typed subject leaves it as it is.

/**
 * Refusals that only say a countdown started the next item under the press. The answer
 * follows that round's snapshot, so a line would stay under the new round, about nothing.
 */
const RACED: readonly string[] = ["round_changed", "not_revealed"];

/** The draft, its problem, and the start that both the field and the centre's button use. */
export interface NextRound {
  draft: string;
  setDraft: (draft: string) => void;
  /** Why the last start was refused, here or by the server; cleared by typing. */
  problem: SubjectProblem | null;
  busy: boolean;
  /** The start takes the queue's next item: the field is empty and an item waits. */
  fromQueue: boolean;
  start: () => Promise<void>;
  field: RefObject<HTMLInputElement | null>;
}

/**
 * Sends `startRound` with the draft as its subject, checked first with the domain's
 * rules (`draftSubject`). A refused subject, here or by the server (`bad_subject`), shows
 * under the field and takes the focus there; any other refusal goes to `onFailure`, the
 * line under the table. A started round clears the draft; a start from the field keeps
 * the focus in it, a start from the centre's button moves it to the hand (or the centre's
 * status for a PO without a hand). `nextItem`: the id of the queue's next item, if any;
 * `round`: the number of the round on the table, 0 in the lobby. A countdown may start the
 * next item under the press (#52): the round on screen is the answer, and a typed subject
 * stays in the field for the round after it.
 */
export function useNextRound(
  onFailure: (code: string | null) => void,
  nextItem: number | null = null,
  round = 0,
): NextRound {
  const [draft, setDraftState] = useState("");
  const [problem, setProblem] = useState<SubjectProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const fromQueue = nextItem !== null && draft.trim() === "";

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setProblem(null);
  }, []);

  const start = useCallback(async () => {
    // Focusable while busy (aria-disabled), so a second press lands here and is dropped.
    if (pending.current) return;
    const parsed = draftSubject(draft);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      field.current?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    setProblem(null);
    onFailure(null);
    const send = commandSender();
    try {
      const ack = await send(
        fromQueue && nextItem !== null
          ? { type: "startNext", payload: { id: nextItem } }
          : { type: "startRound", payload: { subject: parsed.subject, round } },
      );
      if (ack.ok) {
        setDraftState("");
        // The button is gone with the old phase: its focus goes to the hand. A start from
        // the field keeps the focus there (`focusSoon` leaves a placed focus alone): the
        // field stays, Enter in it does nothing while Voting, so a second Enter is not a
        // vote. The hand also ignores Enter and Space just after it got the focus.
        focusSoon("[data-hand] [tabindex='0']", "[data-centre-status='voting']");
      } else if (ack.code === "bad_subject") {
        setProblem("bad_subject");
        field.current?.focus();
      } else if (!RACED.includes(ack.code)) {
        onFailure(ack.code);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [draft, onFailure, fromQueue, nextItem, round]);

  return { draft, setDraft, problem, busy, fromQueue, start, field };
}

interface NextSubjectProps {
  next: NextRound;
  /** The number the next round will have, for "Round N" in the hint. */
  nextNumber: number;
  /** Lobby or revealed: Enter starts the round. While Voting it does nothing. */
  canStart: boolean;
  /** The room's queue (#52), when an item waits. */
  queue: QueueSummary | undefined;
}

/**
 * The subject field, for the PO only: empty is "Round N", a title, or a link (Jira and
 * Azure DevOps keys are read by the server). Enter starts the round when the centre
 * offers to; while Voting it does nothing, and the hint says the subject waits for the
 * next round. Nothing is cut or stripped, a refusal says why.
 */
export function NextSubject({ next, nextNumber, canStart, queue }: NextSubjectProps) {
  const t = useT();
  const ids = { field: useId(), hint: useId(), error: useId() };
  const refused = next.problem !== null;
  return (
    <form
      data-next-subject
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (canStart) void next.start();
      }}
      // `group`: on a phone or a short screen the hint shows only while the field has the
      // focus (#22).
      className="group relative mx-auto flex w-full max-w-xl flex-col gap-1.5 phone:gap-1 squat:gap-1"
    >
      {/*
        On a phone, and on a short screen such as a phone on its side, the label sits small
        inside the field's top edge: a line less above the table.
      */}
      <label
        htmlFor={ids.field}
        className="text-sm font-medium phone:pointer-events-none phone:absolute phone:top-[5px] phone:left-[13px] phone:text-[0.6875rem]/3 phone:text-ink-2 squat:pointer-events-none squat:absolute squat:top-[5px] squat:left-[13px] squat:text-[0.6875rem]/3 squat:text-ink-2"
      >
        {t("round.subjectLabel")}
      </label>
      <div className="flex gap-2">
        <Input
          ref={next.field}
          id={ids.field}
          name="subject"
          value={next.draft}
          onChange={(event) => next.setDraft(event.target.value)}
          autoComplete="off"
          enterKeyHint={canStart ? "go" : "done"}
          aria-invalid={refused || undefined}
          aria-describedby={refused ? `${ids.error} ${ids.hint}` : ids.hint}
          className="phone:pt-4 phone:pb-0 squat:pt-4 squat:pb-0"
        />
        <RoomQueueButton count={queue?.count ?? 0} />
      </div>
      {refused ? (
        <p id={ids.error} role="alert" className="m-0 flex items-start gap-2 text-sm">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {problemMessage(t, next.problem ?? "bad_subject")}
        </p>
      ) : null}
      {/*
        On a phone or a short screen the hint would cost two lines above the table: it shows while the field
        has the focus, over the subject line rather than in the flow (a tap on "Start
        voting" blurs the field, and a hint that collapsed then would move the button from
        under the finger), and in the flow after a refusal. Hidden, it still describes the
        field.
      */}
      <p
        id={ids.hint}
        className={cn(
          "m-0 text-sm text-ink-2",
          !refused &&
            "phone:absolute phone:inset-x-0 phone:top-full phone:z-30 phone:mt-1 phone:hidden phone:rounded-md phone:border phone:border-line phone:bg-surface phone:px-3 phone:py-2 phone:shadow-panel phone:group-focus-within:block squat:absolute squat:inset-x-0 squat:top-full squat:z-30 squat:mt-1 squat:hidden squat:rounded-md squat:border squat:border-line squat:bg-surface squat:px-3 squat:py-2 squat:shadow-panel squat:group-focus-within:block",
        )}
      >
        {!canStart
          ? t("round.subjectHintVoting", { round: nextNumber })
          : queue === undefined
            ? t("round.subjectHint", { round: nextNumber })
            : t("queue.subjectHint", { item: itemName(queue.next) })}
      </p>
    </form>
  );
}
