import { OctagonXIcon } from "lucide-react";
import { type RefObject, useCallback, useId, useRef, useState } from "react";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { focusSoon } from "./round-centre.tsx";
import { draftSubject, problemMessage, type SubjectProblem } from "./subject.ts";

// The PO's next round (#21): a subject field above the table and the centre's button
// ("Start voting" in the lobby, "Next round" after a reveal). The field stays while a
// round is voting, so the PO can prepare the next ticket and the table never jumps; only
// the button starts a round, and a voting round has none (the domain would abandon it).

/** The draft, its problem, and the start that both the field and the centre's button use. */
export interface NextRound {
  draft: string;
  setDraft: (draft: string) => void;
  /** Why the last start was refused, here or by the server; cleared by typing. */
  problem: SubjectProblem | null;
  busy: boolean;
  start: () => Promise<void>;
  field: RefObject<HTMLInputElement | null>;
}

/**
 * Sends `startRound` with the draft as its subject, checked first with the domain's
 * rules (`draftSubject`). A refused subject, here or by the server (`bad_subject`), shows
 * under the field and takes the focus there; any other refusal goes to `onFailure`, the
 * line under the table. A started round clears the draft; a start from the field keeps
 * the focus in it, a start from the centre's button moves it to the hand (or the centre's
 * status for a PO without a hand).
 */
export function useNextRound(onFailure: (code: string | null) => void): NextRound {
  const [draft, setDraftState] = useState("");
  const [problem, setProblem] = useState<SubjectProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);

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
      const ack = await send({ type: "startRound", payload: { subject: parsed.subject } });
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
      } else {
        onFailure(ack.code);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [draft, onFailure]);

  return { draft, setDraft, problem, busy, start, field };
}

interface NextSubjectProps {
  next: NextRound;
  /** The number the next round will have, for "Round N" in the hint. */
  nextNumber: number;
  /** Lobby or revealed: Enter starts the round. While Voting it does nothing. */
  canStart: boolean;
}

/**
 * The subject field, for the PO only: empty is "Round N", a title, or a link (Jira and
 * Azure DevOps keys are read by the server). Enter starts the round when the centre
 * offers to; while Voting it does nothing, and the hint says the subject waits for the
 * next round. Nothing is cut or stripped, a refusal says why.
 */
export function NextSubject({ next, nextNumber, canStart }: NextSubjectProps) {
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
      className="mx-auto flex w-full max-w-xl flex-col gap-1.5"
    >
      <label htmlFor={ids.field} className="text-sm font-medium">
        {t("round.subjectLabel")}
      </label>
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
      />
      {refused ? (
        <p id={ids.error} role="alert" className="m-0 flex items-start gap-2 text-sm">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {problemMessage(t, next.problem ?? "bad_subject")}
        </p>
      ) : null}
      <p id={ids.hint} className="m-0 text-sm text-ink-2">
        {canStart
          ? t("round.subjectHint", { round: nextNumber })
          : t("round.subjectHintVoting", { round: nextNumber })}
      </p>
    </form>
  );
}
