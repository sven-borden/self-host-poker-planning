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

interface AvatarProps {
  id: string;
  name: string;
  /** Diameter in whole pixels. */
  size: number;
  className?: string;
}

/** Decorative: the seat or list item around it carries the name for screen readers. */
export function Avatar({ id, name, size, className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-avatar
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-display leading-none font-bold text-on-avatar ring-2 ring-surface select-none",
        AVATAR_BACKGROUNDS[avatarColour(id) - 1],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials(name)}
    </span>
  );
}
