import { MAX_PARTICIPANTS } from "@pp/domain";
import type { CauseView, RoomSettingsView, RoomView, RoundView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";
import { cardLabel } from "../table/cards.tsx";
import { type RevealSummary, revealSummary, summarySentence } from "./results-view.ts";
import { deckName, SETTING_KEYS, type SettingKey, sameSetting } from "./settings-words.ts";
import { subjectName } from "./subject.ts";

// What the table's live region says (#17): joins, leaves, away and back, votes, a new
// round (#18) or a re-vote (#32), the reveal (#19), the PO's final estimate (#32) and the
// PO's settings changes (#25), read from a snapshot's causes. Never a person's card: a
// vote cause carries who, never what, the reveal says the round's result (#20: "Cards
// revealed. Consensus on 8."), and the final is the PO's decision; both belong to nobody.
// Pure, so the batching rules are tested without timers; `live-announcer.tsx` runs them.

export type LiveKind =
  | "settings"
  | "roundStarted"
  | "joined"
  | "left"
  | "away"
  | "back"
  | "voted"
  | "revealed"
  | "final";

export interface LiveEvent {
  kind: LiveKind;
  /** The person, or "" for the room's own events (a new round). */
  who: string;
  /** The name as the room showed it when the event happened. */
  name: string;
  /** The reveal's result, when the snapshot shows the round revealed (#20). */
  summary?: RevealSummary;
  /**
   * A new round: its number and subject, said with it (#21: "Voting started: ABC-123."),
   * and whether it is anonymous (#25: "Voting started: Round 4, anonymous.").
   */
  round?: Pick<RoundView, "number" | "subject" | "anonymous">;
  /** A new round that is a re-vote (#32): "a new vote on the same subject". */
  revote?: boolean;
  /** The final estimate the PO recorded, and whether it replaced an earlier one (#32). */
  final?: { card: string; changed: boolean };
  /**
   * A setting the PO changed (#25), with the room's settings before and after, and the
   * number of the next round, from which a change of anonymity applies. A deck or specials
   * change during Voting restarts the round (#26): `restarted` is its number, and
   * `voteAgain` whether the viewer has a hand to play again.
   */
  setting?: {
    key: SettingKey;
    from: RoomSettingsView;
    to: RoomSettingsView;
    nextRound: number;
    restarted?: number;
    voteAgain?: boolean;
    /** The change shows in the voting round on the table, which a reconnect missed starting. */
    now?: true;
  };
}

/**
 * Said in this order, whatever order the events came in: the last vote, then the reveal.
 * A settings change is the exception: it is said where it happened among the others
 * (`describeEvents`), so a change made just after "Start voting" follows it.
 */
const ORDER: readonly Exclude<LiveKind, "settings">[] = [
  "roundStarted",
  "joined",
  "left",
  "away",
  "back",
  "voted",
  "revealed",
  "final",
];

/** Events that undo each other inside one batch: nothing is said for either. */
const UNDOES: Partial<Record<LiveKind, LiveKind>> = {
  joined: "left",
  left: "joined",
  away: "back",
  back: "away",
};

function nameOf(id: string, ...rooms: (RoomView | null)[]): string | null {
  for (const room of rooms) {
    const person = room?.participants.find((p) => p.id === id);
    if (person) return person.name;
  }
  return null;
}

/**
 * The events in `causes`, the causes of the change from `previous` to `next`. The viewer's
 * own actions are left out: they see them happen, and their own controls speak for them.
 * A vote counts only when the person had not voted yet in this round: changing a card is
 * not news, and saying so would hint that something changed. A person who left is named
 * from `previous`. A new round and the reveal (forced, automatic or at the deadline) are
 * said to everyone, the PO who caused them too: the hand and the centre change under
 * their focus. A snapshot with no causes (the one a reconnect brings) still says the
 * reveal when it shows the round revealed that `previous` showed voting: the cards turn
 * over on screen, so the reveal is news, once.
 */
export function liveEvents(
  next: RoomView,
  causes: readonly CauseView[],
  previous: RoomView | null,
): LiveEvent[] {
  const before =
    previous?.round && next.round && previous.round.number === next.round.number
      ? new Set(previous.round.voted)
      : new Set<string>();
  const events: LiveEvent[] = [];
  for (const cause of causes) {
    let kind: LiveKind;
    switch (cause.type) {
      case "roundStarted":
        // A deck change restarted the round: the settings event says it, with its deck.
        if (cause.restarted) continue;
        events.push({
          kind: cause.type,
          who: "",
          name: "",
          round: next.round ?? {
            number: cause.number,
            subject: { kind: "none" },
            anonymous: !next.settings.revealNames,
          },
          ...(cause.revote ? { revote: true } : {}),
        });
        continue;
      case "finalSet":
        events.push({
          kind: "final",
          who: "",
          name: "",
          final: { card: cause.card, changed: hadFinal(previous, next) },
        });
        continue;
      case "revealed":
        events.push(revealedEvent(next));
        continue;
      case "joined":
      case "left":
      case "away":
      case "back":
        kind = cause.type;
        break;
      case "kicked":
        kind = "left";
        break;
      case "voteCast":
        if (cause.who === undefined || before.has(cause.who)) continue;
        kind = "voted";
        break;
      default:
        continue;
    }
    const who = cause.who;
    if (who === undefined || who === next.you) continue;
    const name = nameOf(who, next, previous);
    if (name !== null) events.push({ kind, who, name });
  }
  if (!events.some((e) => e.kind === "revealed") && revealedSince(previous, next)) {
    events.push(revealedEvent(next));
  }
  return [...settingEvents(previous, next), ...events];
}

/**
 * The settings that differ between `previous` and `next` (#25), one event each. Read from
 * the settings themselves rather than the `settingsUpdated` cause, so a reconnect that
 * missed a change still says it. Never to the PO: they made the change in their own
 * panel, whose switch says it.
 */
function settingEvents(previous: RoomView | null, next: RoomView): LiveEvent[] {
  if (previous === null || next.you === next.ownerId) return [];
  const from = previous.settings;
  const to = next.settings;
  // A round starts with the room's anonymity; the one on the table keeps its own.
  const nextRound = (next.round?.number ?? 0) + 1;
  const restarted = restartedRound(previous, next);
  const voteAgain = next.participants.some((p) => p.id === next.you && p.role === "voter");
  return SETTING_KEYS.filter((key) => !sameSetting(from, to, key)).map((key) => ({
    kind: "settings",
    who: key,
    name: "",
    setting: !(key === "deck" || key === "specials")
      ? { key, from, to, nextRound }
      : restarted !== null
        ? { key, from, to, nextRound, restarted, voteAgain }
        : next.round?.phase === "voting"
          ? { key, from, to, nextRound, now: true }
          : { key, from, to, nextRound },
  }));
}

/**
 * The number of the voting round a deck or specials change restarted between `previous`
 * and `next` (#26: same number, one more restart), or null.
 */
function restartedRound(previous: RoomView, next: RoomView): number | null {
  const was = previous.round;
  const now = next.round;
  return was?.phase === "voting" &&
    now?.phase === "voting" &&
    now.number === was.number &&
    (now.restarts ?? 0) > (was.restarts ?? 0)
    ? now.number
    : null;
}

/** The reveal, with the result `next` shows (none when a new round already replaced it). */
function revealedEvent(next: RoomView): LiveEvent {
  const round = next.round;
  return round?.phase === "revealed"
    ? { kind: "revealed", who: "", name: "", summary: revealSummary(round) }
    : { kind: "revealed", who: "", name: "" };
}

/** Whether `previous` showed a final for the round `next` shows: a new final is a change. */
function hadFinal(previous: RoomView | null, next: RoomView): boolean {
  const was = previous?.round;
  return was?.phase === "revealed" && was.final !== undefined && was.number === next.round?.number;
}

/** Whether `next` shows revealed the same round that `previous` showed voting. */
function revealedSince(previous: RoomView | null, next: RoomView): boolean {
  const was = previous?.round;
  const now = next.round;
  return (
    was?.phase === "voting" &&
    now?.phase === "revealed" &&
    now.number === was.number &&
    now.startedAt === was.startedAt
  );
}

/**
 * Adds `events` to a batch waiting to be said: a repeat is dropped, and an event that
 * undoes one in the batch (a person away and back again) removes both. A new round makes
 * a reveal still waiting in the batch moot (a timer's reveal resolved by the next round's
 * start): the revealed cards are already gone, and so is a final waiting with them. Of
 * two new rounds in one batch, the later one is said, with its own subject. Of two finals,
 * the later card is said, as recorded when the first one was recorded (#32).
 */
export function mergeEvents(pending: readonly LiveEvent[], events: readonly LiveEvent[]) {
  let merged = [...pending];
  for (const event of events) {
    if (event.setting) {
      // A setting changed twice in one batch: said once, from where it started to where
      // it ended, or not at all when it came back.
      const earlier = merged.find((e) => e.kind === "settings" && e.who === event.who);
      merged = merged.filter((e) => e !== earlier);
      const setting = { ...event.setting, from: earlier?.setting?.from ?? event.setting.from };
      if (!sameSetting(setting.from, setting.to, setting.key)) merged.push({ ...event, setting });
      continue;
    }
    if (event.kind === "roundStarted") {
      merged = merged.filter(
        (e) => e.kind !== "revealed" && e.kind !== "roundStarted" && e.kind !== "final",
      );
    }
    const earlier = merged.find((e) => e.kind === "final");
    if (event.kind === "final" && earlier?.final && event.final) {
      const final = { card: event.final.card, changed: earlier.final.changed };
      merged = merged.map((e) => (e === earlier ? { ...e, final } : e));
      continue;
    }
    const undone = UNDOES[event.kind];
    const opposite = merged.findIndex((e) => e.who === event.who && e.kind === undone);
    if (opposite >= 0) {
      merged = merged.filter((_, i) => i !== opposite);
      continue;
    }
    if (merged.some((e) => e.who === event.who && e.kind === event.kind)) continue;
    merged.push(event);
  }
  return merged;
}

function sentence(t: TFunction, kind: LiveKind, events: readonly LiveEvent[]): string {
  const first = events[0];
  const one = events.length === 1 && first !== undefined;
  const name = first?.name ?? "";
  const count = events.length;
  switch (kind) {
    case "settings":
      return events.flatMap((e) => (e.setting ? [settingSentence(t, e.setting)] : [])).join(" ");
    case "roundStarted":
      if (first?.revote) return t(first.round?.anonymous ? "live.revoteAnonymous" : "live.revote");
      return t(first?.round?.anonymous ? "live.roundStartedAnonymous" : "live.roundStarted", {
        subject: first?.round ? subjectName(t, first.round) : "",
      });
    case "joined":
      return one ? t("live.joined", { name }) : t("live.joinedMany", { count });
    case "left":
      return one ? t("live.left", { name }) : t("live.leftMany", { count });
    case "away":
      return one ? t("live.away", { name }) : t("live.awayMany", { count });
    case "back":
      return one ? t("live.back", { name }) : t("live.backMany", { count });
    case "voted":
      return one ? t("live.voted", { name }) : t("live.votedMany", { count });
    case "revealed":
      return first?.summary
        ? `${t("live.revealed")} ${summarySentence(t, first.summary)}`
        : t("live.revealed");
    case "final": {
      const card = cardLabel(t, first?.final?.card ?? "");
      return t(first?.final?.changed ? "live.finalChanged" : "live.finalRecorded", { card });
    }
  }
}

/** What a changed setting means for the room, in plain words. */
function settingSentence(t: TFunction, setting: NonNullable<LiveEvent["setting"]>): string {
  const { key, to, nextRound, restarted } = setting;
  if (restarted !== undefined && (key === "deck" || key === "specials")) {
    // "The product owner restarted round 4 with T-shirt sizes. Vote again."
    const said =
      key === "deck"
        ? t("live.deckRestarted", { round: restarted, deck: deckName(t, to.deck) })
        : t("live.specialsRestarted", { round: restarted });
    return setting.voteAgain ? `${said} ${t("live.voteAgain")}` : said;
  }
  switch (key) {
    case "deck":
      return t(setting.now ? "live.deckNow" : "live.deckChanged", { deck: deckName(t, to.deck) });
    case "specials":
      return t(setting.now ? "live.specialsNow" : "live.specialsChanged");
    case "timer":
      return t("live.timerChanged");
    case "revealWhenAllVoted":
      return t(to.revealWhenAllVoted ? "live.autoRevealOn" : "live.autoRevealOff");
    case "whoCanReveal":
      return t(to.whoCanReveal === "anyone" ? "live.revealAnyone" : "live.revealOwner");
    case "revealNames":
      return t(to.revealNames ? "live.anonymousOff" : "live.anonymousOn", { round: nextRound });
    case "allowChangeAfterReveal":
      return t(
        to.allowChangeAfterReveal ? "live.changeAfterRevealOn" : "live.changeAfterRevealOff",
      );
    case "poVotes":
      return t(to.poVotes ? "live.poVotesOn" : "live.poVotesOff");
    case "observersCount":
      return t(to.observersCount ? "live.observersCountOn" : "live.observersCountOff", {
        max: MAX_PARTICIPANTS,
      });
  }
}

/**
 * One announcement for a batch: a sentence per kind, naming the person when there is one
 * ("Ana voted."), counting them when there are several ("3 people voted."). A settings
 * change keeps its place in the batch: the events before it are said first, then the
 * change, then the events after it.
 */
export function describeEvents(t: TFunction, events: readonly LiveEvent[]): string {
  const parts: string[] = [];
  let run: LiveEvent[] = [];
  const sayRun = () => {
    for (const kind of ORDER) {
      const ofKind = run.filter((e) => e.kind === kind);
      if (ofKind.length > 0) parts.push(sentence(t, kind, ofKind));
    }
    run = [];
  };
  for (const event of events) {
    if (event.kind !== "settings") {
      run.push(event);
      continue;
    }
    sayRun();
    parts.push(sentence(t, "settings", [event]));
  }
  sayRun();
  return parts.join(" ");
}
