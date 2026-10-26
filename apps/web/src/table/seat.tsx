import { CheckIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import type { TFunction } from "../i18n/i18n.ts";
import { useT } from "../i18n/i18n-context.tsx";
import { Avatar } from "./avatar.tsx";
import { cardLabel, isSpecialCard } from "./cards.tsx";
import type { SeatGeometry, SeatPlace } from "./layout.ts";

/** Where a person stands in the round, as the server's snapshot says (W1). */
export type SeatStatus =
  | { kind: "present" }
  | { kind: "thinking" }
  | { kind: "voted" }
  /** After reveal: the card played, or null when the person did not vote. */
  | { kind: "revealed"; card: string | null };

export interface TablePerson {
  id: string;
  name: string;
  status: SeatStatus;
}

/** "Ana, voted", "Ben, thinking", "Cleo, card 5", or just the name in the lobby. */
export function seatLabel(t: TFunction, { name, status }: TablePerson): string {
  switch (status.kind) {
    case "present":
      return name;
    case "thinking":
      return t("table.seatThinking", { name });
    case "voted":
      return t("table.seatVoted", { name });
    case "revealed":
      if (status.card === null) {
        return t("table.seatNoVote", { name });
      }
      return isSpecialCard(status.card)
        ? t("table.seatCardWord", { name, card: cardLabel(t, status.card) })
        : t("table.seatCard", { name, card: status.card });
  }
}

function statusText(t: TFunction, status: SeatStatus): string | null {
  switch (status.kind) {
    case "present":
      return null;
    case "thinking":
      return t("table.thinking");
    case "voted":
      return t("table.voted");
    case "revealed":
      return status.card === null ? t("table.noVote") : cardLabel(t, status.card);
  }
}

/** The "voted" badge: a check in a green disc, so the state never rests on colour alone. */
function VotedBadge({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      data-badge="voted"
      className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-good text-surface ring-2 ring-surface"
      style={{ width: size, height: size }}
    >
      <CheckIcon width={size - 6} height={size - 6} strokeWidth={3.5} />
    </span>
  );
}

interface SeatProps {
  person: TablePerson;
  place: SeatPlace;
  geometry: SeatGeometry;
}

/**
 * One person at the table: avatar plus name, the name on the side away from the table.
 * Initials-only seats (more than 10 people on a phone) are 44 px buttons that show the
 * name in a popover on tap. The list item carries the full label for screen readers.
 */
export function Seat({ person, place, geometry }: SeatProps) {
  const t = useT();
  const label = seatLabel(t, person);
  const voted = person.status.kind === "voted";
  const avatar = geometry.avatar;
  const badge = avatar >= 40 ? 17 : 15;

  if (!geometry.label) {
    const size = geometry.target;
    const state = statusText(t, person.status);
    return (
      <li
        data-seat
        className="absolute"
        style={{
          left: `calc(${place.x}% - ${size / 2}px)`,
          top: `calc(${place.y}% - ${size / 2}px)`,
          width: size,
          height: size,
        }}
      >
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-seat-part="avatar"
              className="grid size-full cursor-pointer place-items-center rounded-full"
            >
              <span className="relative">
                <Avatar id={person.id} name={person.name} size={avatar} />
                {voted ? <VotedBadge size={badge} /> : null}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side={place.label === "above" ? "top" : "bottom"}
            className="w-auto max-w-60 px-3 py-2 text-sm"
          >
            <p className="m-0 font-semibold break-words">{person.name}</p>
            {state ? <p className="m-0 text-xs text-ink-2">{state}</p> : null}
          </PopoverContent>
        </Popover>
      </li>
    );
  }

  const { width, height: labelHeight, gap } = geometry.label;
  const above = place.label === "above";
  return (
    <li
      data-seat
      className="absolute flex items-center"
      style={{
        flexDirection: above ? "column-reverse" : "column",
        gap,
        width,
        left: `calc(${place.x}% - ${width / 2}px)`,
        // The avatar's centre sits on the seat's point; the name hangs off the far side.
        top: `calc(${place.y}% - ${above ? avatar / 2 + gap + labelHeight : avatar / 2}px)`,
      }}
    >
      <span className="sr-only">{label}</span>
      <span data-seat-part="avatar" aria-hidden="true" className="relative">
        <Avatar id={person.id} name={person.name} size={avatar} />
        {voted ? <VotedBadge size={badge} /> : null}
      </span>
      <span
        data-seat-part="name"
        aria-hidden="true"
        title={person.name}
        className="block w-full truncate text-center font-semibold text-ink"
        style={{
          height: labelHeight,
          lineHeight: `${labelHeight}px`,
          fontSize: labelHeight >= 16 ? 12 : 11,
        }}
      >
        {person.name}
      </span>
    </li>
  );
}
