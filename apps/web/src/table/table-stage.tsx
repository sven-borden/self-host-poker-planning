import { type ReactNode, useId } from "react";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { Avatar } from "./avatar.tsx";
import { SlotCard, type SlotFace } from "./cards.tsx";
import { layoutTable, type TableVariant, variantFor } from "./layout.ts";
import { FLIP_STAGGER_MS, revealSettleMs } from "./reveal-motion.ts";
import {
  flagWords,
  type PersonFlags,
  Seat,
  type SeatStatus,
  shownName,
  type TablePerson,
} from "./seat.tsx";
import { useRoomWidth } from "./use-room-width.ts";
import "./table.css";

export interface Observer extends PersonFlags {
  id: string;
  name: string;
}

interface TableStageProps {
  /** People at the table; index 0 is the viewer, seated at the bottom. At most 16. */
  people: TablePerson[];
  /** People watching: a row under the table, never a seat. */
  observers?: Observer[];
  /**
   * Forces a variant; by default it follows the width the container gives the table
   * (`variantFor` in layout.ts).
   */
  variant?: TableVariant;
  /** The status in the middle of the table: count, timer or result. */
  children?: ReactNode;
  /**
   * A person whose slot card is hidden for a moment: a card is flying to it (#18), and the
   * slot shows once it has landed.
   */
  hiddenSlot?: string | null;
  className?: string;
}

function slotFace(status: SeatStatus): { face: SlotFace; value: string | null } {
  switch (status.kind) {
    case "voted":
      return { face: status.dealt ? "gone" : "down", value: null };
    case "revealed":
      return status.card === null
        ? { face: "empty", value: null }
        : { face: "up", value: status.card };
    default:
      return { face: "empty", value: null };
  }
}

/**
 * The boardroom table (ADR-005): a stage with the stadium table, a card slot per person,
 * the seats around it, and a status area in the middle. Presentational only: it renders
 * the people it is given and decides nothing. At a reveal the face-up cards turn over one
 * after the other in seat order, from the viewer at the bottom (`FLIP_STAGGER_MS`).
 */
export function TableStage({
  people,
  observers = [],
  variant,
  children,
  hiddenSlot = null,
  className,
}: TableStageProps) {
  const t = useT();
  const [roomRef, room] = useRoomWidth<HTMLDivElement>();
  const layout = layoutTable(
    people.length,
    variant ?? (room === null ? "desktop" : variantFor(room)),
  );
  const seated = people.slice(0, layout.count);
  const observersId = useId();
  // The nth face-up card in seat order turns n × 90 ms after the first (#19).
  let turned = 0;
  const slots = seated.map((person, i) => {
    const point = layout.slots[i];
    if (!point) {
      return null;
    }
    const { face, value } = slotFace(person.status);
    const turnDelay = face === "up" ? turned++ * FLIP_STAGGER_MS : 0;
    return (
      <div
        key={person.id}
        data-slot-card
        data-you={person.you || undefined}
        aria-hidden="true"
        className={cn("absolute", person.id === hiddenSlot && "invisible")}
        style={{
          left: `calc(${point.x}% - ${layout.slot.width / 2}px)`,
          top: `calc(${point.y}% - ${layout.slot.height / 2}px)`,
        }}
      >
        <SlotCard face={face} value={value} size={layout.slot} turnDelay={turnDelay} />
      </div>
    );
  });
  // The lowest and highest seats are marked once the last card has turned (#20).
  const settle = revealSettleMs(turned, false);

  return (
    <div ref={roomRef} className={cn("w-full", className)}>
      <div
        data-stage
        data-variant={layout.variant}
        className="pp-stage relative mx-auto w-full"
        style={{
          aspectRatio: layout.aspect,
          maxWidth: layout.maxWidth,
          minHeight: layout.minStageHeight || undefined,
        }}
      >
        <div
          data-table
          aria-hidden="true"
          className="pp-felt absolute rounded-full"
          style={{
            left: `${layout.table.x}%`,
            right: `${layout.table.x}%`,
            top: `${layout.table.y}%`,
            bottom: `${layout.table.y}%`,
          }}
        />
        {slots}
        {/* Content taller than the box (the PO's controls on a phone) overflows it evenly. */}
        <div
          data-centre
          className="absolute grid place-content-center place-items-center text-center text-[12.5px] leading-snug text-balance text-table-ink in-data-[variant=phone]:text-[11px]"
          style={{
            left: `calc(50% - ${layout.centre.width / 2}px)`,
            top: `calc(50% - ${layout.centre.height / 2}px)`,
            width: layout.centre.width,
            height: layout.centre.height,
          }}
        >
          {children}
        </div>
        <ul aria-label={t("table.seats")} className="m-0 list-none p-0">
          {seated.map((person, i) => {
            const place = layout.seats[i];
            return place ? (
              <Seat
                key={person.id}
                person={person}
                place={place}
                geometry={layout.seat}
                settle={settle}
              />
            ) : null;
          })}
        </ul>
      </div>
      {observers.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <p
            id={observersId}
            className="m-0 font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase"
          >
            {t("table.observers")}
          </p>
          <ul
            aria-labelledby={observersId}
            className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0"
          >
            {observers.map((observer) => (
              <ObserverItem key={observer.id} observer={observer} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One observer in the row under the table. The row has room for words, so what sets the
 * person apart is written out after the name ("Away", "Product owner"), and the avatar
 * turns grey when they are away; the viewer's name is in spruce with a ring on the avatar.
 */
function ObserverItem({ observer }: { observer: Observer }) {
  const t = useT();
  const words = flagWords(t, observer);
  const tags = [
    observer.owner ? t("table.ownerTag") : null,
    observer.away ? t("table.awayTag") : null,
  ].filter((tag) => tag !== null);
  return (
    <li
      data-observer
      data-away={observer.away || undefined}
      data-you={observer.you || undefined}
      data-owner={observer.owner || undefined}
      className="flex items-center gap-1.5"
    >
      <Avatar
        id={observer.id}
        name={observer.name}
        size={24}
        look={observer.look}
        away={observer.away}
        className={cn(observer.you && "outline-2 outline-offset-2 outline-spruce")}
      />
      <span
        dir="auto"
        className={cn(
          "max-w-32 truncate text-[12px]",
          observer.you && !observer.away ? "font-semibold text-spruce" : "text-ink-2",
        )}
      >
        <bdi>{shownName(t, observer)}</bdi>
      </span>
      {words.length > 0 ? <span className="sr-only">, {words.join(", ")}</span> : null}
      {tags.length > 0 ? (
        <span aria-hidden="true" className="font-mono text-[10.5px] tracking-[0.06em] text-ink-2">
          {tags.join(" · ")}
        </span>
      ) : null}
    </li>
  );
}
