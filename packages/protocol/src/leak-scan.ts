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
 * Every key and every string in a value, each with its path: a key's path ends in the key
 * (`rounds.0.votes.who`, value `who`), a string's is where it sits.
 */
function keysAndStrings(
  value: unknown,
  path: string,
): Array<{ path: string; value: string; key: boolean }> {
  if (typeof value === "string") return [{ path, value, key: false }];
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const at = `${path}.${key}`;
    return [{ path: at, value: key, key: true }, ...keysAndStrings(child, at)];
  });
}

/**
 * The leaks in a `history` answer (#33), each with its path (`rounds.2.votes.cards.0`): a
 * user id anywhere in a row, in any string or key, alone or inside a longer one, and a
 * `who` key (no row names its voters by id); in an anonymous round's row also a person's
 * name, as a string or a key, or a `name` key at all. The server's socket tests scan real
 * frames with it, and the four-person e2e every history answer a page receives.
 */
export function historyLeaks(
  answer: unknown,
  people: HistoryPeople,
): Array<{ path: string; value: string }> {
  const ids = [...people.ids].filter((id) => id !== "");
  const names = new Set(people.names);
  const rounds = isRecord(answer) && Array.isArray(answer.rounds) ? answer.rounds : [];
  return rounds.flatMap((row: unknown, i) => {
    const anonymous = isRecord(row) && isRecord(row.votes) && row.votes.kind === "anonymous";
    return keysAndStrings(row, `rounds.${i}`)
      .filter(
        ({ value, key }) =>
          ids.some((id) => value.includes(id)) ||
          (key && value === "who") ||
          (anonymous && (names.has(value) || (key && value === "name"))),
      )
      .map(({ path, value }) => ({ path, value }));
  });
}
