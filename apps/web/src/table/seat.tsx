import { CheckIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
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

/** The name and state in a popover, for seats that cannot show the whole name. */
function SeatPopover({ person, side }: { person: TablePerson; side: SeatPlace["label"] }) {
  const t = useT();
  const state = statusText(t, person.status);
  return (
    <PopoverContent
      side={side === "above" ? "top" : "bottom"}
      className="w-auto max-w-60 px-3 py-2 text-sm"
    >
      <p className="m-0 font-semibold break-words">
        <bdi>{person.name}</bdi>
      </p>
      {state ? <p className="m-0 text-xs text-ink-2">{state}</p> : null}
    </PopoverContent>
  );
}

/**
 * True when the element's text is cut off. Measured before paint and again once the web
 * fonts have loaded, since they change the text's width.
 */
function useTruncated(name: string, width: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the name, the width or the element (a button once truncated) changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    let live = true;
    const check = () => {
      if (live) {
        setTruncated(element.scrollWidth > element.clientWidth);
      }
    };
    check();
    document.fonts?.ready.then(check);
    return () => {
      live = false;
    };
  }, [name, width, truncated]);
  return [ref, truncated] as const;
}

interface SeatProps {
  person: TablePerson;
  place: SeatPlace;
  geometry: SeatGeometry;
}

/**
 * One person at the table: avatar plus name, the name on the side away from the table.
 * Initials-only seats (more than 10 people on a phone) are 44 px buttons that show the
 * name in a popover on tap; so is a seat whose name is cut off, as a button the size of
 * the seat. Otherwise the list item carries the full label for screen readers.
 */
export function Seat({ person, place, geometry }: SeatProps) {
  const t = useT();
  const label = seatLabel(t, person);
  const voted = person.status.kind === "voted";
  const avatar = geometry.avatar;
  const badge = avatar >= 40 ? 17 : 15;
  const [nameRef, truncated] = useTruncated(person.name, geometry.label?.width ?? 0);

  if (!geometry.label) {
    const size = geometry.target;
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
          <SeatPopover person={person} side={place.label} />
        </Popover>
      </li>
    );
  }

  const { width, height: labelHeight, gap } = geometry.label;
  const above = place.label === "above";
  const parts = (
    <>
      <span data-seat-part="avatar" aria-hidden="true" className="relative">
        <Avatar id={person.id} name={person.name} size={avatar} />
        {voted ? <VotedBadge size={badge} /> : null}
      </span>
      <span
        ref={nameRef}
        data-seat-part="name"
        aria-hidden="true"
        className="block w-full truncate text-center font-semibold text-ink"
        style={{
          height: labelHeight,
          lineHeight: `${labelHeight}px`,
          fontSize: labelHeight >= 16 ? 12 : 11,
        }}
      >
        <bdi>{person.name}</bdi>
      </span>
    </>
  );
  const column = "flex items-center";
  const direction = { flexDirection: above ? "column-reverse" : "column", gap } as const;
  return (
    <li
      data-seat
      className="absolute"
      style={{
        width,
        left: `calc(${place.x}% - ${width / 2}px)`,
        // The avatar's centre sits on the seat's point; the name hangs off the far side.
        top: `calc(${place.y}% - ${above ? avatar / 2 + gap + labelHeight : avatar / 2}px)`,
      }}
    >
      {truncated ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-seat-trigger
              className={`${column} w-full cursor-pointer rounded-md p-0`}
              style={direction}
            >
              {parts}
            </button>
          </PopoverTrigger>
          <SeatPopover person={person} side={place.label} />
        </Popover>
      ) : (
        <div className={column} style={direction}>
          <span className="sr-only">{label}</span>
          {parts}
        </div>
      )}
    </li>
  );
}
