import type { ParticipantView } from "@pp/protocol";

/** How two names compare when a screen reader says them: case and form aside. */
const spoken = (name: string) => name.normalize("NFC").toLocaleLowerCase();

/**
 * For each person whose name someone who joined earlier already goes by (`spoken`), which
 * one of that name they are in the current join order: 2, 3, …. The first keeps the name
 * alone. Numbers follow the people in the room now: when the first Ana leaves, the second
 * one's "(2)" goes (#22).
 */
export function namesakes(participants: readonly ParticipantView[]): Map<string, number> {
  const count = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const { id, name } of participants) {
    const key = spoken(name);
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    if (n > 1) numbers.set(id, n);
  }
  return numbers;
}
