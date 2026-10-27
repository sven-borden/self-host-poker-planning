import { baseCards, MAX_MEMBERS, MAX_PARTICIPANTS, type SettingsPatch } from "@pp/domain";
import type { RoomSettingsView, RoomView } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { type Formatters, useFormat, useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { commandSender } from "../realtime/room-connection.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { codeOf, failureMessage } from "./failure.ts";
import { deckName, type SettingKey } from "./settings-words.ts";

// The room's settings (#25): one panel, opened from the room's header. The PO changes
// the settings whose behaviour the room already shows; everyone else, and the PO for a
// setting whose control is not built yet, reads the value and what it means. A lazy
// chunk of its own (`settings-button.tsx` loads it on the first open).
//
// Adding a control (#26 to #30): give the setting's field in `GROUPS` a `Control`, a
// component that renders the input with `ControlProps.id` and calls `change` with only
// the keys it changes. The panel does the rest: the label points at the control, the hint
// describes it, the change shows at once and stays pending until the server's snapshot
// confirms it, and a refusal rolls it back with its message under the setting.

/** What a setting's control gets from the panel. */
export interface ControlProps {
  /** The settings as shown: the room's, with the PO's unconfirmed changes folded in. */
  settings: RoomSettingsView;
  /** Sends `updateSettings` with this patch: only the keys that change. */
  change: (patch: SettingsPatch) => void;
  /** A change of this setting is on its way; a second one waits until it is answered. */
  pending: boolean;
  /** The control's id: the setting's `<label>` points at it. */
  id: string;
  /** The ids that describe the control (the hint, and a refusal when there is one). */
  describedBy: string;
}

/** One setting in the panel. */
export interface SettingField {
  key: SettingKey;
  label: (t: TFunction) => string;
  hint: (t: TFunction) => string;
  /** The value in words, as everyone reads it. */
  value: (t: TFunction, settings: RoomSettingsView, format: Formatters) => string;
  /** A line under the hint, or null: the deck's cards, the timer's end, the round's names. */
  detail?: (t: TFunction, settings: RoomSettingsView, room: RoomView) => string | null;
  /** The PO's switch, for an on-off setting. */
  toggle?: Toggle;
  /** The PO's control for any other setting. */
  Control?: ComponentType<ControlProps>;
  // A field with neither shows its value to the PO too, until its issue adds one.
}

interface SettingGroup {
  id: "cards" | "round" | "people";
  title: (t: TFunction) => string;
  fields: readonly SettingField[];
}

const onOff = (t: TFunction, on: boolean) => t(on ? "settings.on" : "settings.off");

const SPOKEN = { "?": "cards.unsure", "☕": "cards.coffee", "∞": "cards.infinite" } as const;

/** An on-off setting, as the PO's switch reads and writes it. */
export interface Toggle {
  read: (settings: RoomSettingsView) => boolean;
  /** The patch for the new position: only the keys that change. */
  write: (on: boolean) => SettingsPatch;
}

/** The switch of an on-off setting (`SettingField.toggle`). */
function SettingSwitch({
  toggle,
  settings,
  change,
  pending,
  id,
  describedBy,
}: ControlProps & { toggle: Toggle }) {
  return (
    <Switch
      id={id}
      checked={toggle.read(settings)}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      // 44 px to touch, whatever the switch draws (design brief).
      className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5 aria-disabled:opacity-60"
      onCheckedChange={(on) => change(toggle.write(on))}
    />
  );
}

/**
 * The settings in the order the panel shows them (ADR-011's list). Editable now: the
 * settings whose behaviour the room already shows end to end. The deck and specials
 * (#26), the timer (#27), who can reveal (#28) and changes after the reveal (#29) are
 * read-only until their issue adds a `Control`.
 */
export const GROUPS: readonly SettingGroup[] = [
  {
    id: "cards",
    title: (t) => t("settings.groupCards"),
    fields: [
      {
        key: "deck",
        label: (t) => t("settings.deck"),
        hint: (t) => t("settings.deckHint"),
        value: (t, s) => deckName(t, s.deck),
        detail: (_t, s) => baseCards(s.deck).join(", "),
      },
      {
        key: "specials",
        label: (t) => t("settings.specials"),
        hint: (t) => t("settings.specialsHint"),
        value: (t, s, format) =>
          s.specials.length === 0
            ? t("settings.specialsNone")
            : format.list(s.specials.map((card) => `${card} ${t(SPOKEN[card])}`)),
      },
    ],
  },
  {
    id: "round",
    title: (t) => t("settings.groupRound"),
    fields: [
      {
        key: "timer",
        label: (t) => t("settings.timer"),
        hint: (t) => t("settings.timerHint"),
        value: (t, s) =>
          s.timer.seconds === null
            ? t("settings.off")
            : t("settings.timerSeconds", { seconds: s.timer.seconds }),
        detail: (t, s) =>
          s.timer.seconds === null
            ? null
            : t(s.timer.revealAtEnd ? "settings.timerThenReveal" : "settings.timerThenTimeUp"),
      },
      {
        key: "revealWhenAllVoted",
        label: (t) => t("settings.revealWhenAllVoted"),
        hint: (t) => t("settings.revealWhenAllVotedHint"),
        value: (t, s) => onOff(t, s.revealWhenAllVoted),
        toggle: { read: (s) => s.revealWhenAllVoted, write: (on) => ({ revealWhenAllVoted: on }) },
      },
      {
        key: "whoCanReveal",
        label: (t) => t("settings.whoCanReveal"),
        hint: (t) => t("settings.whoCanRevealHint"),
        value: (t, s) =>
          t(s.whoCanReveal === "anyone" ? "settings.revealByAnyone" : "settings.revealByOwner"),
      },
      {
        key: "revealNames",
        label: (t) => t("settings.anonymous"),
        hint: (t) => t("settings.anonymousHint"),
        value: (t, s) => onOff(t, !s.revealNames),
        // The round on the table keeps the anonymity it started with.
        detail: (t, s, room) =>
          room.round === null || room.round.anonymous === !s.revealNames
            ? null
            : t(room.round.anonymous ? "settings.roundStaysAnonymous" : "settings.roundStaysNamed"),
        toggle: { read: (s) => !s.revealNames, write: (on) => ({ revealNames: !on }) },
      },
      {
        key: "allowChangeAfterReveal",
        label: (t) => t("settings.changeAfterReveal"),
        hint: (t) => t("settings.changeAfterRevealHint"),
        value: (t, s) => t(s.allowChangeAfterReveal ? "settings.allowed" : "settings.notAllowed"),
      },
    ],
  },
  {
    id: "people",
    title: (t) => t("settings.groupPeople"),
    fields: [
      {
        key: "poVotes",
        label: (t) => t("settings.poVotes"),
        hint: (t) => t("settings.poVotesHint"),
        value: (t, s) => onOff(t, s.poVotes),
        toggle: { read: (s) => s.poVotes, write: (on) => ({ poVotes: on }) },
      },
      {
        key: "observersCount",
        label: (t) => t("settings.observersCount", { max: MAX_PARTICIPANTS }),
        hint: (t) => t("settings.observersCountHint", { total: MAX_MEMBERS }),
        value: (t, s) => onOff(t, s.observersCount),
        toggle: { read: (s) => s.observersCount, write: (on) => ({ observersCount: on }) },
      },
    ],
  },
];

/** A phone: the `phone:` variant in styles.css. The panel is a bottom sheet there. */
const PHONE_QUERY = "(max-width: 640px)";

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

/** `settings` with `patch` applied as the domain merges it: shallow, `timer` one level deep. */
export function withPatch(settings: RoomSettingsView, patch: SettingsPatch): RoomSettingsView {
  return { ...settings, ...patch, timer: { ...settings.timer, ...patch.timer } };
}

type Pending = Partial<Record<SettingKey, SettingsPatch>>;

function without(pending: Pending, key: SettingKey): Pending {
  const rest = { ...pending };
  delete rest[key];
  return rest;
}

/**
 * The PO's changes: each is shown at once and sent as `updateSettings` through the
 * `commandSender()` taken at the press. It stays pending until the ack, which comes once
 * the store holds the server's snapshot (the server broadcasts before it acks); a refusal
 * drops it, so the setting rolls back to the room's value and the reason shows.
 */
function useSettingChanges(confirmed: RoomSettingsView) {
  const [pending, setPending] = useState<Pending>({});
  const inFlight = useRef(new Set<SettingKey>());
  const [failure, setFailure] = useState<{ key: SettingKey; code: string } | null>(null);

  async function change(key: SettingKey, patch: SettingsPatch) {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const send = commandSender();
    setPending((before) => ({ ...before, [key]: patch }));
    setFailure(null);
    let code: string | null = null;
    try {
      const ack = await send({ type: "updateSettings", payload: { patch } });
      if (!ack.ok) code = ack.code;
    } catch (error) {
      code = codeOf(error);
    }
    inFlight.current.delete(key);
    setPending((before) => without(before, key));
    if (code !== null) setFailure({ key, code });
  }

  const shown = Object.values(pending).reduce<RoomSettingsView>(withPatch, confirmed);
  return { shown, pending, failure, change };
}

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the panel closes: the button that opened it. */
  returnFocus: RefObject<HTMLElement | null>;
}

/**
 * "Room settings" for the PO, "Room rules" for everyone else: a side sheet on a wide
 * screen, a bottom sheet on a phone. A modal dialog: the focus stays inside while it is
 * open, Esc closes it, and the focus goes back to the header's button.
 */
export function SettingsPanel({ open, onOpenChange, returnFocus }: SettingsPanelProps) {
  const phone = useSyncExternalStore(subscribePhone, isPhone);
  const room = useRoomStore((state) => state.snapshot?.room);
  return (
    <Sheet open={open && room !== undefined} onOpenChange={onOpenChange}>
      <SheetContent
        side={phone ? "bottom" : "right"}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain border-line bg-surface",
          phone
            ? "max-h-[88dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
            : "w-full sm:max-w-md",
        )}
        onCloseAutoFocus={(event) => {
          // The button lives outside this chunk, so the dialog has no trigger of its own.
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        {room !== undefined ? <PanelBody room={room} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ room }: { room: RoomView }) {
  const t = useT();
  const owner = room.you !== null && room.you === room.ownerId;
  const changes = useSettingChanges(room.settings);
  return (
    <div data-settings-panel={owner ? "owner" : "rules"}>
      <SheetHeader className="gap-1 pr-14">
        <SheetTitle className="text-xl font-[760] [font-stretch:110%]">
          {t(owner ? "settings.openOwner" : "settings.openOthers")}
        </SheetTitle>
        <SheetDescription className="text-ink-2">
          {t(owner ? "settings.ledeOwner" : "settings.ledeOthers")}
        </SheetDescription>
      </SheetHeader>
      {GROUPS.map((group) => (
        <SettingsGroup key={group.id} group={group}>
          {group.fields.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              room={room}
              settings={changes.shown}
              editable={owner}
              pending={changes.pending[field.key] !== undefined}
              failure={changes.failure?.key === field.key ? changes.failure.code : null}
              change={(patch) => changes.change(field.key, patch)}
            />
          ))}
        </SettingsGroup>
      ))}
    </div>
  );
}

function SettingsGroup({ group, children }: { group: SettingGroup; children: ReactNode }) {
  const t = useT();
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-settings-group={group.id}
      className="border-t border-line px-4 pt-3 pb-1"
    >
      <h3 id={heading} className="m-0 font-mono text-xs tracking-[0.08em] text-ink-2 uppercase">
        {group.title(t)}
      </h3>
      <dl className="m-0 divide-y divide-line">{children}</dl>
    </section>
  );
}

interface FieldRowProps {
  field: SettingField;
  room: RoomView;
  settings: RoomSettingsView;
  editable: boolean;
  pending: boolean;
  failure: string | null;
  change: (patch: SettingsPatch) => void;
}

function FieldRow({ field, room, settings, editable, pending, failure, change }: FieldRowProps) {
  const t = useT();
  const format = useFormat();
  const ids = { control: useId(), hint: useId(), error: useId() };
  const label = field.label(t);
  const detail = field.detail?.(t, settings, room) ?? null;
  // Turning observers on in a room past 16 counted: say why, with the numbers.
  const message =
    failure === null
      ? null
      : failure === "room_full" && field.key === "observersCount"
        ? t("settings.observersCountRefused", { max: MAX_PARTICIPANTS })
        : failureMessage(t, failure);
  const props: ControlProps = {
    settings,
    change,
    pending,
    id: ids.control,
    describedBy: message === null ? ids.hint : `${ids.hint} ${ids.error}`,
  };
  const { toggle, Control } = field;
  const control = !editable ? null : toggle ? (
    <SettingSwitch toggle={toggle} {...props} />
  ) : Control ? (
    <Control {...props} />
  ) : null;
  return (
    <div
      data-setting={field.key}
      data-pending={pending || undefined}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3"
    >
      <dt className="font-medium">
        {control !== null ? <label htmlFor={ids.control}>{label}</label> : label}
      </dt>
      <dd className="col-start-2 row-span-2 row-start-1 m-0 flex max-w-44 justify-end pt-0.5 text-right">
        {control ?? (
          <span data-setting-value className="font-semibold">
            {field.value(t, settings, format)}
          </span>
        )}
      </dd>
      <dd className="m-0 text-sm text-ink-2">
        <p id={ids.hint} className="m-0">
          {field.hint(t)}
        </p>
        {detail !== null ? (
          <p data-setting-detail className="m-0 mt-1 text-ink">
            {detail}
          </p>
        ) : null}
        {pending ? (
          <p data-setting-saving className="m-0 mt-1">
            {t("settings.saving")}
          </p>
        ) : null}
        {message !== null ? (
          <p id={ids.error} role="alert" className="m-0 mt-2 flex items-start gap-2 text-ink">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {message}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
