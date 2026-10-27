import { cn } from "../lib/utils.ts";

// Avatar placeholders until W4 (docs/03-design-brief.md, "Tokens"): initials on one of
// eight colours, picked from the user id so a person keeps their colour everywhere.

// Literal class names, so Tailwind generates them.
const AVATAR_BACKGROUNDS = [
  "bg-av1",
  "bg-av2",
  "bg-av3",
  "bg-av4",
  "bg-av5",
  "bg-av6",
  "bg-av7",
  "bg-av8",
] as const;

/** 1 to 8: which `--av` colour this id gets. FNV-1a, so it is stable everywhere. */
export function avatarColour(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % AVATAR_BACKGROUNDS.length) + 1;
}

/** "Ana Lima" → "AL", "Ana" → "An", "  " → "?". Letters, not UTF-16 halves. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) {
    return "?";
  }
  const letters = (word: string) => Array.from(word);
  if (words.length === 1) {
    const [a = "", b = ""] = letters(first);
    return a.toLocaleUpperCase() + b.toLocaleLowerCase();
  }
  const last = words[words.length - 1] ?? "";
  return ((letters(first)[0] ?? "") + (letters(last)[0] ?? "")).toLocaleUpperCase();
}

/** What an avatar shows: its initials and its colour (1 to 8). */
export interface AvatarLook {
  initials: string;
  colour: number;
}

/**
 * Looks that tell everyone at a table apart (#17): no two people share both initials and
 * colour, and nobody shares a colour while 8 or fewer people are there. A person's colour
 * comes from their id (`avatarColour`), so a leave or a rename changes as few colours as
 * possible: in join order, the first person with each colour keeps it whatever happens
 * to the others, and only those who had to give way to them can change. Each of those
 * takes, in join order, the least used colour after their own that nobody with the same
 * initials has. Past 8 people with the same initials, a number replaces the second letter
 * ("A2").
 */
export function avatarLooks(
  people: readonly { id: string; name: string }[],
): Map<string, AvatarLook> {
  const chosen = new Map<string, AvatarLook>();
  const taken = new Set<string>();
  const uses = new Array<number>(AVATAR_BACKGROUNDS.length).fill(0);
  const key = (look: AvatarLook) => `${look.colour}:${look.initials}`;
  const give = (id: string, look: AvatarLook) => {
    chosen.set(id, look);
    taken.add(key(look));
    uses[look.colour - 1] = (uses[look.colour - 1] ?? 0) + 1;
  };
  // The first person (in join order) with each colour keeps it.
  const gaveWay: { id: string; name: string }[] = [];
  const claimed = new Set<number>();
  for (const person of people) {
    if (chosen.has(person.id) || gaveWay.some((other) => other.id === person.id)) {
      continue;
    }
    const own = avatarColour(person.id);
    if (claimed.has(own)) {
      gaveWay.push(person);
      continue;
    }
    claimed.add(own);
    give(person.id, { initials: initials(person.name), colour: own });
  }
  // The others, in join order: the least used colour after their own that is free.
  for (const { id, name } of gaveWay) {
    const own = avatarColour(id);
    const base = initials(name);
    let look: AvatarLook | undefined;
    for (let n = 1; !look; n++) {
      const text = n === 1 ? base : `${Array.from(base)[0] ?? "?"}${n}`;
      for (let step = 0; step < AVATAR_BACKGROUNDS.length; step++) {
        const colour = ((own - 1 + step) % AVATAR_BACKGROUNDS.length) + 1;
        const candidate = { initials: text, colour };
        if (taken.has(key(candidate))) {
          continue;
        }
        if (!look || (uses[colour - 1] ?? 0) < (uses[look.colour - 1] ?? 0)) {
          look = candidate;
        }
      }
    }
    give(id, look);
  }
  // In join order, as the table lists people.
  const looks = new Map<string, AvatarLook>();
  for (const { id } of people) {
    const look = chosen.get(id);
    if (look && !looks.has(id)) {
      looks.set(id, look);
    }
  }
  return looks;
}

interface AvatarProps {
  id: string;
  name: string;
  /** Diameter in whole pixels. */
  size: number;
  /** Set by the table, so that nobody looks like somebody else (`avatarLooks`). */
  look?: AvatarLook | undefined;
  /**
   * Gone for a while: a grey disc with a dashed edge instead of the colour, at full
   * opacity, so the initials keep their contrast (`--ink-2` on `--surface-2`).
   */
  away?: boolean | undefined;
  className?: string;
}

/** Decorative: the seat or list item around it carries the name for screen readers. */
export function Avatar({ id, name, size, look, away, className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-avatar
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-display leading-none font-bold ring-2 ring-surface select-none",
        away
          ? "border border-dashed border-line-strong bg-surface-2 text-ink-2"
          : ["text-on-avatar", AVATAR_BACKGROUNDS[(look?.colour ?? avatarColour(id)) - 1]],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {look?.initials ?? initials(name)}
    </span>
  );
}
