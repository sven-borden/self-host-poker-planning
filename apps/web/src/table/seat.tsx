import { CheckIcon, CrownIcon, MoonIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { Avatar, type AvatarLook } from "./avatar.tsx";
import { cardLabel, isSpecialCard } from "./cards.tsx";
import type { SeatGeometry, SeatPlace } from "./layout.ts";

/** Where a person stands in the round, as the server's snapshot says (W1). */
export type SeatStatus =
  | { kind: "present" }
  | { kind: "thinking" }
  /**
   * Voted; `dealt` after an anonymous reveal, when the card left the seat for the row
   * under the table (#19) and only the fact that the person voted stays with them.
   */
  | { kind: "voted"; dealt?: boolean }
  /** After reveal: the card played, or null when the person did not vote. */
  | { kind: "revealed"; card: string | null };

/** Who someone is at the table, beside their state in the round (#17). */
export interface PersonFlags {
  /** Gone for longer than the grace period: a grey avatar, with a moon badge. */
  away?: boolean | undefined;
  /** The product owner: a crown badge on the avatar. */
  owner?: boolean | undefined;
  /** The viewer: a ring around the avatar. */
  you?: boolean | undefined;
  /** Initials and colour, unique at the table (`avatarLooks`). */
  look?: AvatarLook | undefined;
}

export interface TablePerson extends PersonFlags {
  id: string;
  name: string;
  status: SeatStatus;
}

/** What sets a person apart, in words for screen readers: ["you", "product owner", "away"]. */
export function flagWords(t: TFunction, person: PersonFlags): string[] {
  const words: string[] = [];
  if (person.you) {
    words.push(t("table.you"));
  }
  if (person.owner) {
    words.push(t("table.owner"));
  }
  if (person.away) {
    words.push(t("table.away"));
  }
  return words;
}

/** The name with what sets the person apart, for screen readers: "Ana, you, away". */
export function nameWithFlags(t: TFunction, person: { name: string } & PersonFlags): string {
  return [person.name, ...flagWords(t, person)].join(", ");
}

/**
 * "Ana, voted", "Ben, product owner, away, thinking", "Cleo, card 5", or the name and its
 * flags alone in the lobby.
 */
export function seatLabel(t: TFunction, person: TablePerson): string {
  const name = nameWithFlags(t, person);
  const { status } = person;
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

interface BadgesProps {
  voted?: boolean | undefined;
  owner?: boolean | undefined;
  away?: boolean | undefined;
  /** The disc's diameter in pixels. */
  size: number;
}

/**
 * The avatar's badges, each a shape in a disc so that no state rests on colour alone: a
 * check (voted) bottom right, a crown (product owner) top left, a moon (away) top right.
 * Each overhangs the avatar by 4 px, inside the seat's halo (`AVATAR_HALO`). The parent
 * must be positioned.
 */
export function AvatarBadges({ voted, owner, away, size }: BadgesProps) {
  const icon = { width: size - 6, height: size - 6 };
  const disc = "absolute grid place-items-center rounded-full ring-2 ring-surface";
  const box = { width: size, height: size };
  return (
    <>
      {owner ? (
        <span
          aria-hidden="true"
          data-badge="owner"
          className={cn(disc, "-top-1 -left-1 bg-brass-soft text-brass-ink")}
          style={box}
        >
          <CrownIcon {...icon} strokeWidth={2.75} />
        </span>
      ) : null}
      {away ? (
        <span
          aria-hidden="true"
          data-badge="away"
          className={cn(disc, "-top-1 -right-1 bg-surface-2 text-ink-2")}
          style={box}
        >
          <MoonIcon {...icon} strokeWidth={2.75} />
        </span>
      ) : null}
      {voted ? (
        <span
          aria-hidden="true"
          data-badge="voted"
          className={cn(disc, "-right-1 -bottom-1 bg-good text-surface")}
          style={box}
        >
          <CheckIcon {...icon} strokeWidth={3.5} />
        </span>
      ) : null}
    </>
  );
}

/**
 * The avatar with its badges. Away, its disc turns grey with a dashed edge and the
 * initials stay readable (the moon badge and the label say so too); the viewer's gets a
 * spruce ring outside its own, 4 px out at most.
 */
function SeatAvatar({ person, size, badge }: { person: TablePerson; size: number; badge: number }) {
  return (
    <span className="relative block">
      <Avatar
        id={person.id}
        name={person.name}
        size={size}
        look={person.look}
        away={person.away}
        className={cn(person.you && "outline-2 outline-offset-2 outline-spruce")}
      />
      <AvatarBadges
        voted={person.status.kind === "voted"}
        owner={person.owner}
        away={person.away}
        size={badge}
      />
    </span>
  );
}

/**
 * The whole name and what the badges mean ("Product owner · Away · Voted") in a popover:
 * the name may be cut off or shown as initials, and a badge is a shape without words.
 */
function SeatPopover({ person, side }: { person: TablePerson; side: SeatPlace["label"] }) {
  const t = useT();
  const state = [
    person.owner ? t("table.ownerTag") : null,
    person.away ? t("table.awayTag") : null,
    statusText(t, person.status),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <PopoverContent
      side={side === "above" ? "top" : "bottom"}
      className="w-auto max-w-60 px-3 py-2 text-sm"
    >
      <p className="m-0 font-semibold break-words">
        <bdi>{person.name}</bdi>
      </p>
      {state !== "" ? <p className="m-0 text-xs text-ink-2">{state}</p> : null}
    </PopoverContent>
  );
}

interface SeatProps {
  person: TablePerson;
  place: SeatPlace;
  geometry: SeatGeometry;
}

/**
 * One person at the table: avatar plus name, the name on the side away from the table.
 * Every seat is a button that opens the whole name and the state in a popover, on tap or
 * by keyboard: initials-only seats (more than 10 people on a phone) as 44 px buttons, the
 * others as a button the size of the seat, so a cut-off name and every badge can be read
 * in words. A seat stays a button whatever its state, so the focus never drops when
 * someone votes or goes away.
 */
export function Seat({ person, place, geometry }: SeatProps) {
  const t = useT();
  const label = seatLabel(t, person);
  const avatar = geometry.avatar;
  const badge = avatar >= 40 ? 17 : 15;
  const marks = {
    "data-away": person.away || undefined,
    "data-you": person.you || undefined,
    "data-owner": person.owner || undefined,
  };

  if (!geometry.label) {
    const size = geometry.target;
    return (
      <li
        data-seat
        {...marks}
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
              <SeatAvatar person={person} size={avatar} badge={badge} />
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
      <span data-seat-part="avatar" aria-hidden="true">
        <SeatAvatar person={person} size={avatar} badge={badge} />
      </span>
      <span
        data-seat-part="name"
        aria-hidden="true"
        dir="auto"
        className={cn(
          "block w-full truncate text-center font-semibold",
          person.away ? "text-ink-2" : person.you ? "text-spruce" : "text-ink",
        )}
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
      {...marks}
      className="absolute"
      style={{
        width,
        left: `calc(${place.x}% - ${width / 2}px)`,
        // The avatar's centre sits on the seat's point; the name hangs off the far side.
        top: `calc(${place.y}% - ${above ? avatar / 2 + gap + labelHeight : avatar / 2}px)`,
      }}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-seat-trigger
            className={`${column} w-full cursor-pointer rounded-md p-0`}
            style={direction}
          >
            {/* The button's name: the visible parts are hidden from screen readers. */}
            <span className="sr-only">{label}</span>
            {parts}
          </button>
        </PopoverTrigger>
        <SeatPopover person={person} side={place.label} />
      </Popover>
    </li>
  );
}
