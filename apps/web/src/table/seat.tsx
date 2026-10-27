import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CrownIcon, MoonIcon } from "lucide-react";
import { type ReactNode, type Ref, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { Avatar, type AvatarLook } from "./avatar.tsx";
import { cardLabel, isSpecialCard } from "./cards.tsx";
import type { SeatGeometry, SeatPlace } from "./layout.ts";
import { cancelAll, play, popIn, prefersReducedMotion } from "./reveal-motion.ts";

/** After a named reveal whose cards differ: the lowest or the highest card played (#20). */
export type Extreme = "low" | "high";

/** Where a person stands in the round, as the server's snapshot says (W1). */
export type SeatStatus =
  | { kind: "present" }
  | { kind: "thinking" }
  /**
   * Voted; `dealt` after an anonymous reveal, when the card left the seat for the row
   * under the table (#19) and only the fact that the person voted stays with them.
   */
  | { kind: "voted"; dealt?: boolean }
  /**
   * After reveal: the card played, or null when the person did not vote; `extreme` marks
   * the lowest and highest cards of a named round, to start the discussion (#20).
   */
  | { kind: "revealed"; card: string | null; extreme?: Extreme | undefined };

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
  /**
   * Someone who joined earlier has the same name: which one of that name this is (2, 3,
   * …), so that every seat's label is a name of its own: "Ana (2)" (#22).
   */
  namesake?: number | undefined;
}

export interface TablePerson extends PersonFlags {
  id: string;
  name: string;
  status: SeatStatus;
}

/** Someone the PO may act on from their seat or the observers' row (#30). */
export interface ActionTarget extends PersonFlags {
  id: string;
  name: string;
  role: "voter" | "observer";
}

/**
 * What a person's popover holds beside their name and state: the PO's actions (#30),
 * given by the room, which knows who is looking. `close` closes the popover, and the focus
 * goes back to the person's button. Nothing (null) for anyone else.
 */
export type PersonActions = (person: ActionTarget, close: () => void) => ReactNode;

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

/**
 * The name as the room shows and says it, wherever a name appears: "Ana Lima", or "Ana
 * Lima (2)" for the second person of that name in the room (`namesakes`, #22).
 */
export function shownName(
  t: TFunction,
  person: { name: string; namesake?: number | undefined },
): string {
  return person.namesake === undefined
    ? person.name
    : t("table.nameNumbered", { name: person.name, number: person.namesake });
}

/**
 * The name with what sets the person apart, for screen readers: "Ana, you, away", or
 * "Ana (2), away" for the second Ana in the room.
 */
export function nameWithFlags(t: TFunction, person: { name: string } & PersonFlags): string {
  return [shownName(t, person), ...flagWords(t, person)].join(", ");
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
      return [
        isSpecialCard(status.card)
          ? t("table.seatCardWord", { name, card: cardLabel(t, status.card) })
          : t("table.seatCard", { name, card: status.card }),
        ...(status.extreme ? [extremeWord(t, status.extreme)] : []),
      ].join(", ");
  }
}

/** "lowest card", "highest card", as a seat's label or a column's says it. */
export function extremeWord(t: TFunction, extreme: Extreme): string {
  return t(extreme === "low" ? "table.lowest" : "table.highest");
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

interface ExtremeMarkProps {
  extreme: Extreme;
  /** The disc's diameter in pixels. */
  size: number;
  className?: string;
  ref?: Ref<HTMLSpanElement> | undefined;
}

/**
 * The lowest or highest card's mark (#20): an arrow down or up in a spruce disc, so the
 * shape says which, never the colour alone. On a seat it overhangs the avatar bottom right
 * (the voted check's corner, free after a named reveal); the results panel repeats it.
 */
export function ExtremeMark({ extreme, size, className, ref }: ExtremeMarkProps) {
  const Icon = extreme === "low" ? ArrowDownIcon : ArrowUpIcon;
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-badge={extreme === "low" ? "lowest" : "highest"}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-spruce text-on-spruce",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon width={size - 5} height={size - 5} strokeWidth={3.25} />
    </span>
  );
}

interface SeatAvatarProps {
  person: TablePerson;
  size: number;
  badge: number;
  /** When the cards are settled after a reveal (ms): an extreme badge pops in then. */
  settle: number;
}

/**
 * The avatar with its badges. Away, its disc turns grey with a dashed edge and the
 * initials stay readable (the moon badge and the label say so too); the viewer's gets a
 * spruce ring outside its own, 4 px out at most. A lowest or highest mark that appears
 * on screen (a reveal) pops in once the cards are settled; one there when the seat mounts
 * (a reload) shows at rest.
 */
function SeatAvatar({ person, size, badge, settle }: SeatAvatarProps) {
  const extreme = person.status.kind === "revealed" ? person.status.extreme : undefined;
  const mark = useRef<HTMLSpanElement>(null);
  const before = useRef(extreme);
  const delay = useRef(settle);
  delay.current = settle;

  useLayoutEffect(() => {
    const was = before.current;
    before.current = extreme;
    if (!extreme || was === extreme) return;
    const popping = play(mark.current, popIn(delay.current, prefersReducedMotion()));
    return () => cancelAll([popping]);
  }, [extreme]);

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
      {extreme ? (
        <ExtremeMark
          ref={mark}
          extreme={extreme}
          size={badge}
          className="absolute -right-1 -bottom-1 ring-2 ring-surface"
        />
      ) : null}
    </span>
  );
}

/** "Product owner · Away · Voted": what the badges and the slot say, in words. */
function seatState(t: TFunction, person: TablePerson): string {
  return [
    person.owner ? t("table.ownerTag") : null,
    person.away ? t("table.awayTag") : null,
    statusText(t, person.status),
    person.status.kind === "revealed" && person.status.extreme
      ? t(person.status.extreme === "low" ? "table.lowestTag" : "table.highestTag")
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

interface PersonPopoverProps {
  person: { name: string; namesake?: number | undefined };
  /** What the badges mean, in words; "" for nothing. */
  state: string;
  side: "top" | "bottom";
  /** The PO's actions on this person (#30), if any. */
  actions?: ReactNode;
}

/**
 * The whole name and what the badges mean ("Product owner · Away · Voted") in a popover:
 * the name may be cut off or shown as initials, and a badge is a shape without words.
 * For the PO it also holds what they can do with this person (#30).
 */
export function PersonPopover({ person, state, side, actions }: PersonPopoverProps) {
  const t = useT();
  const hasActions = actions !== null && actions !== undefined && actions !== false;
  return (
    <PopoverContent
      side={side}
      data-person-popover
      className={cn("w-auto px-3 py-2 text-sm", hasActions ? "max-w-72" : "max-w-60")}
    >
      <p className="m-0 font-semibold break-words">
        <bdi>{shownName(t, person)}</bdi>
      </p>
      {state !== "" ? <p className="m-0 text-xs text-ink-2">{state}</p> : null}
      {actions}
    </PopoverContent>
  );
}

interface SeatProps {
  person: TablePerson;
  place: SeatPlace;
  geometry: SeatGeometry;
  /** When the cards are settled after a reveal, in ms (`revealSettleMs`). */
  settle?: number;
  /** The PO's actions in the seat's popover (#30). */
  actions?: PersonActions | undefined;
}

/**
 * One person at the table: avatar plus name, the name on the side away from the table.
 * Every seat is a button that opens the whole name and the state in a popover, on tap or
 * by keyboard: initials-only seats (more than 10 people on a phone) as 44 px buttons, the
 * others as a button the size of the seat, so a cut-off name and every badge can be read
 * in words. A seat stays a button whatever its state, so the focus never drops when
 * someone votes or goes away.
 */
export function Seat({ person, place, geometry, settle = 0, actions }: SeatProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = seatLabel(t, person);
  const popover = (
    <PersonPopover
      person={person}
      state={seatState(t, person)}
      side={place.label === "above" ? "top" : "bottom"}
      actions={open ? actions?.({ ...person, role: "voter" }, () => setOpen(false)) : null}
    />
  );
  const trigger = { "data-person-trigger": person.id };
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
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              {...trigger}
              data-seat-part="avatar"
              className="grid size-full cursor-pointer place-items-center rounded-full"
            >
              <SeatAvatar person={person} size={avatar} badge={badge} settle={settle} />
            </button>
          </PopoverTrigger>
          {popover}
        </Popover>
      </li>
    );
  }

  const { width, height: labelHeight, gap } = geometry.label;
  const above = place.label === "above";
  const parts = (
    <>
      <span data-seat-part="avatar" aria-hidden="true">
        <SeatAvatar person={person} size={avatar} badge={badge} settle={settle} />
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
        <bdi>{shownName(t, person)}</bdi>
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            {...trigger}
            data-seat-trigger
            className={`${column} w-full cursor-pointer rounded-md p-0`}
            style={direction}
          >
            {/* The button's name: the visible parts are hidden from screen readers. */}
            <span className="sr-only">{label}</span>
            {parts}
          </button>
        </PopoverTrigger>
        {popover}
      </Popover>
    </li>
  );
}
