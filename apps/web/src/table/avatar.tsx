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
 * colour, and nobody shares a colour while 8 or fewer people are there. People are taken
 * in join order, so a newcomer never changes how the others look: each one keeps their
 * own colour (`avatarColour`) when it is free, else takes the least used colour after it
 * that nobody with the same initials has. Past 8 people with the same initials, a number
 * replaces the second letter ("A2").
 */
export function avatarLooks(
  people: readonly { id: string; name: string }[],
): Map<string, AvatarLook> {
  const looks = new Map<string, AvatarLook>();
  const taken = new Set<string>();
  const uses = new Array<number>(AVATAR_BACKGROUNDS.length).fill(0);
  const key = (look: AvatarLook) => `${look.colour}:${look.initials}`;
  for (const { id, name } of people) {
    if (looks.has(id)) {
      continue;
    }
    const own = avatarColour(id);
    const base = initials(name);
    let look: AvatarLook | undefined;
    for (let n = 1; !look; n++) {
      const text = n === 1 ? base : `${Array.from(base)[0] ?? "?"}${n}`;
      let best: AvatarLook | undefined;
      for (let step = 0; step < AVATAR_BACKGROUNDS.length; step++) {
        const colour = ((own - 1 + step) % AVATAR_BACKGROUNDS.length) + 1;
        const candidate = { initials: text, colour };
        if (taken.has(key(candidate))) {
          continue;
        }
        if (!best || (uses[colour - 1] ?? 0) < (uses[best.colour - 1] ?? 0)) {
          best = candidate;
        }
      }
      look = best;
    }
    looks.set(id, look);
    taken.add(key(look));
    uses[look.colour - 1] = (uses[look.colour - 1] ?? 0) + 1;
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
  className?: string;
}

/** Decorative: the seat or list item around it carries the name for screen readers. */
export function Avatar({ id, name, size, look, className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-avatar
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-display leading-none font-bold text-on-avatar ring-2 ring-surface select-none",
        AVATAR_BACKGROUNDS[(look?.colour ?? avatarColour(id)) - 1],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {look?.initials ?? initials(name)}
    </span>
  );
}
