import { useEffect } from "react";
import type { Drawing } from "../avatars/art.ts";
import { holdIdle } from "../avatars/idle.ts";
import { useAvatarDrawing } from "../avatars/use-art.ts";
import { cn } from "../lib/utils.ts";
import "../avatars/avatar.css";

// An avatar (docs/03-design-brief.md, "Avatars"): initials, or the drawing the person
// picked (#42), on one of eight colours, picked from the user id so a person keeps their
// colour everywhere.

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

/** A last word that is a number keeps up to this many digits ("Guest 12" → "G12"). */
const NUMBER_DIGITS = 2;

/**
 * "Ana Lima" → "AL", "Ana" → "An", "  " → "?". Letters, not UTF-16 halves. A name that
 * ends in a number keeps its digits, so "Guest 1" to "Guest 16" read "G1" to "G16", not
 * "G1" seven times.
 */
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
  if (/^\p{Nd}+$/u.test(last)) {
    const digits = letters(last).slice(0, NUMBER_DIGITS).join("");
    return (letters(first)[0] ?? "").toLocaleUpperCase() + digits;
  }
  return ((letters(first)[0] ?? "") + (letters(last)[0] ?? "")).toLocaleUpperCase();
}

/** What an avatar shows: its initials or drawing, and its colour (1 to 8). */
export interface AvatarLook {
  initials: string;
  colour: number;
  /** The drawing's id, shown in place of the initials once it has loaded (#42). */
  art?: string | undefined;
}

/**
 * Looks that tell everyone at a table apart (#17): no two people share both face (a
 * drawing, or else initials) and colour, and nobody shares a colour while 8 or fewer people
 * are there. A person's colour
 * comes from their id (`avatarColour`), so a leave or a rename changes as few colours as
 * possible: in join order, the first person with each colour keeps it whatever happens
 * to the others, and only those who had to give way to them can change. Each of those
 * takes, in join order, the least used colour after their own that nobody with the same
 * face has. Past 8 people with the same initials, a number replaces the second letter
 * ("A2"); past 8 people with the same drawing, the next one shows their initials (#42).
 */
export function avatarLooks(
  people: readonly { id: string; name: string; avatar?: string | undefined }[],
): Map<string, AvatarLook> {
  const chosen = new Map<string, AvatarLook>();
  const taken = new Set<string>();
  const uses = new Array<number>(AVATAR_BACKGROUNDS.length).fill(0);
  const key = (look: AvatarLook) => `${look.colour}:${look.art ?? look.initials}`;
  const give = (id: string, look: AvatarLook) => {
    chosen.set(id, look);
    taken.add(key(look));
    uses[look.colour - 1] = (uses[look.colour - 1] ?? 0) + 1;
  };
  // The first person (in join order) with each colour keeps it.
  const gaveWay: (typeof people)[number][] = [];
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
    give(person.id, { initials: initials(person.name), colour: own, art: person.avatar });
  }
  // The others, in join order: the least used colour after their own that is free.
  for (const { id, name, avatar } of gaveWay) {
    const own = avatarColour(id);
    const base = initials(name);
    let look: AvatarLook | undefined;
    // Their drawing first (n = 0), on any colour nobody else wears it in; then letters.
    for (let n = avatar === undefined ? 1 : 0; !look; n++) {
      const text = n <= 1 ? base : `${Array.from(base)[0] ?? "?"}${n}`;
      for (let step = 0; step < AVATAR_BACKGROUNDS.length; step++) {
        const colour = ((own - 1 + step) % AVATAR_BACKGROUNDS.length) + 1;
        const candidate = { initials: text, colour, art: n === 0 ? avatar : undefined };
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
   * opacity, so the initials keep their contrast (`--ink-2` on `--surface-2`). A drawing
   * turns `--ink-2` too, its eyes shut.
   */
  away?: boolean | undefined;
  /** No idle life, whoever it shows (#42): the picker's other choices. */
  still?: boolean | undefined;
  className?: string | undefined;
}

/** The picked drawing, filling the disc; `data-avatar-art` is what `idle.ts` looks for. */
export function AvatarDrawing({ drawing, idle }: { drawing: Drawing; idle: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      data-avatar-art={idle ? "idle" : "still"}
      className="block size-full"
    >
      {drawing.body.map(([tone, path]) => (
        <path key={path} className={`pp-av-${tone}`} d={path} />
      ))}
      <g data-avatar-eyes className="pp-av-eyes">
        {drawing.eyes.map(([tone, path]) => (
          <path key={path} className={`pp-av-${tone}`} d={path} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Decorative: the seat or list item around it carries the name for screen readers. Forced
 * colours leave a drawing alone: their palette would paint its parts one colour.
 */
export function Avatar({ id, name, size, look, away, still, className }: AvatarProps) {
  const drawing = useAvatarDrawing(look?.art);
  const idle = drawing !== null && !away && !still;
  useEffect(() => (idle ? holdIdle() : undefined), [idle]);
  return (
    <span
      aria-hidden="true"
      data-avatar
      data-avatar-away={drawing && away ? "" : undefined}
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-display leading-none font-bold ring-2 ring-surface select-none",
        drawing && "overflow-hidden forced-color-adjust-none",
        away
          ? "border border-dashed border-line-strong bg-surface-2 text-ink-2"
          : ["text-on-avatar", AVATAR_BACKGROUNDS[(look?.colour ?? avatarColour(id)) - 1]],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {drawing ? (
        <AvatarDrawing drawing={drawing} idle={idle} />
      ) : (
        (look?.initials ?? initials(name))
      )}
    </span>
  );
}
