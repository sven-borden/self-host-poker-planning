/**
 * The avatars a person may pick (#42). The drawings live in the web app; the domain only
 * knows their ids, so nothing but one of these reaches a room's state or the user's row.
 */
export const AVATAR_IDS = [
  "bat",
  "bear",
  "cat",
  "chick",
  "cow",
  "deer",
  "dog",
  "fox",
  "frog",
  "hedgehog",
  "koala",
  "lion",
  "monkey",
  "mouse",
  "otter",
  "owl",
  "panda",
  "penguin",
  "pig",
  "rabbit",
  "raccoon",
  "seal",
  "sheep",
  "tiger",
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

const KNOWN: ReadonlySet<string> = new Set(AVATAR_IDS);

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && KNOWN.has(value);
}
