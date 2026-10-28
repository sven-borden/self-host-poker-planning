/**
 * The secrecy scan, for tests: every string in a snapshot with its path, and the card
 * labels found outside the paths that may hold one. `secrecy.test.ts` runs it over
 * generated rooms, the server's socket tests over real frames. Exported as
 * `@pp/protocol/leak-scan`, never from the package's main entry: no app code needs it.
 */

/** Paths that legitimately hold card labels: the decks, the specials and the viewer's own card. */
export const PUBLIC_CARD_PATHS = [
  "room.settings.deck.",
  "room.settings.specials.",
  "room.round.deck.",
  "room.round.specials.",
] as const;

export const isPublicCardPath = (path: string) =>
  path === "room.round.yourVote" || PUBLIC_CARD_PATHS.some((p) => path.startsWith(p));

/** Every string in a value, with its path (`room.round.voted.0`). */
export function stringLeaves(value: unknown, path = ""): Array<{ path: string; value: string }> {
  if (typeof value === "string") return [{ path, value }];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    stringLeaves(child, path ? `${path}.${key}` : key),
  );
}

/** The strings of a snapshot that equal one of `labels` outside the public card paths. */
export function cardLeaks(
  snapshot: unknown,
  labels: Iterable<string>,
): Array<{ path: string; value: string }> {
  const hidden = new Set(labels);
  return stringLeaves(snapshot).filter(
    (leaf) => hidden.has(leaf.value) && !isPublicCardPath(leaf.path),
  );
}

/** The people a `history` answer must not name: their user ids, and their names. */
export interface HistoryPeople {
  ids: Iterable<string>;
  names: Iterable<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The leaks in a `history` answer (#33), each with its path (`rounds.2.votes.cards.0`): a
 * user id or a `who` anywhere (no row names its voters by id), and in an anonymous round's
 * row a person's name or a `name` field at all. The server's socket tests scan real
 * frames with it, and the four-person e2e every history answer a page receives.
 */
export function historyLeaks(
  answer: unknown,
  people: HistoryPeople,
): Array<{ path: string; value: string }> {
  const ids = new Set(people.ids);
  const names = new Set(people.names);
  const rounds = isRecord(answer) && Array.isArray(answer.rounds) ? answer.rounds : [];
  return rounds.flatMap((row: unknown, i) => {
    const anonymous = isRecord(row) && isRecord(row.votes) && row.votes.kind === "anonymous";
    return stringLeaves(row, `rounds.${i}`).filter(
      ({ path, value }) =>
        ids.has(value) ||
        /(^|\.)who$/.test(path) ||
        (anonymous && (names.has(value) || /(^|\.)name$/.test(path))),
    );
  });
}
