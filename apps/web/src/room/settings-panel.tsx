import { baseCards, MAX_MEMBERS, MAX_PARTICIPANTS, type SettingsPatch } from "@pp/domain";
import type { RoomSettingsView, RoomView } from "@pp/protocol";
import { LockIcon, OctagonXIcon, XIcon } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Sheet,
  SheetClose,
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
import { DeckControl, SpecialsControl } from "./deck-field.tsx";
import { codeOf, failureMessage } from "./failure.ts";
import { deckName, type SettingKey } from "./settings-words.ts";

// The room's settings (#25): one panel, opened from the room's header. The PO changes
// the settings whose behaviour the room already shows; everyone else, and the PO for a
// setting whose control is not built yet, reads the value and what it means. A lazy
// chunk of its own (`settings-button.tsx` loads it on the first open).
//
// Adding a control (#27 to #29; #26's deck and special cards are the worked example in
// `deck-field.tsx`): give the setting's field in `GROUPS` a `toggle` (an
// on-off switch) or a `Control`, a component that renders the input with
// `ControlProps.id` (or labels a group with `aria-labelledby={labelId}`) and calls
// `change` with only the keys it changes. `layout: "block"` gives it the row's whole width.
// The panel does the rest: the label points at the control, the hint describes it, the
// change shows at once and stays pending until the server's snapshot confirms it, and a
// refusal rolls it back with its message under the setting (`refusals` words a code).

/** What a setting's control gets from the panel. */
export interface ControlProps {
  /** The room as the viewer sees it: the round's phase and anonymity, the people. */
  room: RoomView;
  /** The settings as shown: the room's, with the PO's unconfirmed changes folded in. */
  settings: RoomSettingsView;
  /** Sends `updateSettings` with this patch: only the keys that change. */
  change: (patch: SettingsPatch) => void;
  /**
   * A change of this setting is on its way. Show the control `aria-disabled`, keep it
   * focusable: the panel ignores another change of it until the first is answered.
   */
  pending: boolean;
  /** The control's id: the setting's `<label for>` points at it. */
  id: string;
  /** The label's id, for `aria-labelledby` (a radio group cannot use `<label for>`). */
  labelId: string;
  /** The ids that describe the control (the hint, a lock's reason, a refusal). */
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
  /**
   * Where the PO's control sits: `inline` (the default) at the row's end, beside the label,
   * for a switch; `block` across the row under the hint, for a deck picker, a radio group
   * or the timer.
   */
  layout?: "inline" | "block";
  /** The PO's switch, for an on-off setting. */
  toggle?: Toggle;
  /** The PO's control for any other setting. */
  Control?: ComponentType<ControlProps>;
  /**
   * The words for a refusal of this setting, by the server's code, when the generic ones
   * (`errorMessage`) would not say why. A code not listed falls back to those.
   */
  refusals?: Readonly<Partial<Record<string, (t: TFunction) => string>>>;
  // A field with neither a toggle nor a Control shows its value to the PO too, until its
  // issue adds one.
}

export interface SettingGroup {
  id: string;
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
  /**
   * Why the switch cannot move now, or null when it can: the reason shows under the
   * setting and describes the switch, which stays focusable but `aria-disabled`.
   */
  locked?: (room: RoomView, t: TFunction) => string | null;
}

/** The switch of an on-off setting (`SettingField.toggle`). */
function SettingSwitch({
  toggle,
  locked,
  settings,
  change,
  pending,
  id,
  describedBy,
}: ControlProps & { toggle: Toggle; locked: boolean }) {
  const still = pending || locked;
  return (
    <Switch
      id={id}
      checked={toggle.read(settings)}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      aria-disabled={still || undefined}
      // 44 px to touch, whatever the switch draws (design brief).
      className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5 aria-disabled:opacity-60"
      onCheckedChange={(on) => {
        if (!still) change(toggle.write(on));
      }}
    />
  );
}

/**
 * The settings in the order the panel shows them (ADR-011's list). Editable now: the
 * settings whose behaviour the room already shows end to end, the deck and the special
 * cards (#26) among them. The timer (#27), who can reveal (#28) and changes after the
 * reveal (#29) are read-only until their issue adds a control.
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
        layout: "block",
        Control: DeckControl,
      },
      {
        key: "specials",
        label: (t) => t("settings.specials"),
        hint: (t) => t("settings.specialsHint"),
        value: (t, s, format) =>
          s.specials.length === 0 ? t("settings.specialsNone") : format.list(s.specials),
        // What each card says, in words: a symbol alone reads badly aloud.
        detail: (t, s) =>
          s.specials.length === 0
            ? null
            : s.specials.map((card) => `${card} ${t(SPOKEN[card])}`).join(" · "),
        layout: "block",
        Control: SpecialsControl,
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
        // Turning observers on in a room past 16 counted: say why, with the numbers.
        refusals: {
          room_full: (t) => t("settings.observersCountRefused", { max: MAX_PARTICIPANTS }),
        },
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

/** The refusal of a change the page gave up on: the connection dropped while it was on its way. */
export const CONNECTION_DROPPED = "connection_dropped";

type Pending = Partial<Record<SettingKey, SettingsPatch>>;
type Failures = Partial<Record<SettingKey, string>>;

function without<V>(record: Partial<Record<SettingKey, V>>, key: SettingKey) {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/**
 * The PO's changes: each is shown at once and sent as `updateSettings` through the
 * `commandSender()` taken at the press. It stays pending until the ack, which comes once
 * the store holds the server's snapshot (the server broadcasts before it acks); a refusal
 * drops it, so the setting rolls back to the room's value and the reason shows. Another
 * change of the same setting while one is pending is ignored. When the connection drops,
 * a pending change is given up at once (rolled back, "Not saved: the connection
 * dropped."), and a change made while it is down fails the same way; the message goes on
 * reconnect or at the next change.
 */
function useSettingChanges(confirmed: RoomSettingsView) {
  const [pending, setPending] = useState<Pending>({});
  const [failures, setFailures] = useState<Failures>({});
  const inFlight = useRef(new Map<SettingKey, AbortController>());

  useEffect(() => {
    const unsubscribe = useRoomStore.subscribe((state, before) => {
      if (state.status === before.status) return;
      if (state.status === "live") {
        setFailures((now) => {
          const kept = Object.entries(now).filter(([, code]) => code !== CONNECTION_DROPPED);
          return kept.length === Object.keys(now).length ? now : Object.fromEntries(kept);
        });
        return;
      }
      const dropped = [...inFlight.current.entries()];
      if (dropped.length === 0) return;
      inFlight.current.clear();
      for (const [, controller] of dropped) controller.abort();
      setPending({});
      setFailures((now) => ({
        ...now,
        ...Object.fromEntries(dropped.map(([key]) => [key, CONNECTION_DROPPED])),
      }));
    });
    const sends = inFlight.current;
    return () => {
      unsubscribe();
      for (const controller of sends.values()) controller.abort();
    };
  }, []);

  async function change(key: SettingKey, patch: SettingsPatch) {
    if (inFlight.current.has(key)) return;
    setFailures({});
    if (useRoomStore.getState().status !== "live") {
      setFailures({ [key]: CONNECTION_DROPPED });
      return;
    }
    const controller = new AbortController();
    inFlight.current.set(key, controller);
    const send = commandSender();
    setPending((before) => ({ ...before, [key]: patch }));
    let code: string | null = null;
    try {
      const ack = await send(
        { type: "updateSettings", payload: { patch } },
        { signal: controller.signal },
      );
      if (!ack.ok) code = ack.code;
    } catch (error) {
      code = codeOf(error);
    }
    // Given up when the connection dropped: already rolled back and said.
    if (controller.signal.aborted) return;
    inFlight.current.delete(key);
    setPending((before) => without(before, key));
    if (code !== null) setFailures((now) => ({ ...now, [key]: code }));
  }

  const shown = Object.values(pending).reduce<RoomSettingsView>(withPatch, confirmed);
  return { shown, pending, failures, change };
}

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the panel closes: the button that opened it. */
  returnFocus: RefObject<HTMLElement | null>;
  /** The settings to show; `GROUPS` but in a test of the plug-in contract. */
  groups?: readonly SettingGroup[];
}

/** A control the panel can focus: what the first Tab inside a setting's control reaches. */
const FOCUSABLE =
  "[data-setting-control] :is(button, input, select, textarea, [tabindex]:not([tabindex='-1']))";

/**
 * "Room settings" for the PO, "Room rules" for everyone else: a side sheet on a wide
 * screen, a bottom sheet on a phone. A modal dialog: the focus stays inside while it is
 * open, Esc closes it, and the focus goes back to the header's button. It opens at its
 * top; the sticky title never covers the focus (`scroll-padding-top` follows its height),
 * and the sheet keeps clear of a notch and the home indicator (safe areas).
 */
export function SettingsPanel({
  open,
  onOpenChange,
  returnFocus,
  groups = GROUPS,
}: SettingsPanelProps) {
  const phone = useSyncExternalStore(subscribePhone, isPhone);
  const room = useRoomStore((state) => state.snapshot?.room);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open && room !== undefined} onOpenChange={onOpenChange}>
      <SheetContent
        ref={content}
        side={phone ? "bottom" : "right"}
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain border-line bg-surface",
          "scroll-pt-[var(--panel-head,0px)] scroll-pb-[env(safe-area-inset-bottom)]",
          "pb-[env(safe-area-inset-bottom)]",
          phone
            ? "max-h-[88dvh] rounded-t-2xl pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
            : "w-full pr-[env(safe-area-inset-right)] sm:max-w-md",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          openAtTop(content.current);
        }}
        onCloseAutoFocus={(event) => {
          // The button lives outside this chunk, so the dialog has no trigger of its own.
          event.preventDefault();
          returnFocus.current?.focus();
        }}
        onFocus={(event) => keepClearOfHead(content.current, event.target)}
      >
        {room !== undefined ? <PanelBody room={room} groups={groups} side={!phone} /> : null}
      </SheetContent>
    </Sheet>
  );
}

/** The sticky head's height, which the content's `scroll-padding-top` keeps clear. */
const headHeight = (box: HTMLElement) =>
  box.querySelector<HTMLElement>("[data-panel-head]")?.getBoundingClientRect().height ?? 0;

/**
 * Opens at the top: the PO's first control takes the focus when it shows whole under the
 * sticky head; otherwise (anyone else, or a short screen) the title does.
 */
function openAtTop(box: HTMLElement | null) {
  if (!box) return;
  box.scrollTop = 0;
  const first = box.querySelector<HTMLElement>(FOCUSABLE);
  const title = box.querySelector<HTMLElement>("[data-panel-title]");
  if (first) {
    // Relative to the sheet, which may still be sliding in.
    const frame = box.getBoundingClientRect();
    const rect = first.getBoundingClientRect();
    const top = rect.top - frame.top;
    if (top >= headHeight(box) && rect.bottom - frame.top <= box.clientHeight) {
      first.focus({ preventScroll: true });
      return;
    }
  }
  title?.focus({ preventScroll: true });
}

/**
 * Scrolls a focused element out from under the sticky head, where the browser left it, or
 * up from below the sheet's bottom, where the focus trap's wrap from the first control to
 * the last leaves it (Radix focuses without scrolling).
 */
function keepClearOfHead(box: HTMLElement | null, target: EventTarget) {
  if (!box || !(target instanceof HTMLElement) || target.closest("[data-panel-head]")) return;
  requestAnimationFrame(() => {
    const head = box.querySelector("[data-panel-head]")?.getBoundingClientRect();
    if (!head || document.activeElement !== target) return;
    const rect = target.getBoundingClientRect();
    const gap = head.bottom - rect.top;
    if (gap > 0) {
      box.scrollTop -= gap + 8;
      return;
    }
    const below = rect.bottom - box.getBoundingClientRect().bottom;
    if (below > 0) box.scrollTop += below + 8;
  });
}

function PanelBody({
  room,
  groups,
  side,
}: {
  room: RoomView;
  groups: readonly SettingGroup[];
  side: boolean;
}) {
  const t = useT();
  const owner = room.you !== null && room.you === room.ownerId;
  const changes = useSettingChanges(room.settings);
  const head = useRef<HTMLDivElement>(null);

  // The content's scroll padding follows the sticky head's height (a title on two lines,
  // a larger text size).
  useLayoutEffect(() => {
    const element = head.current;
    const box = element?.closest<HTMLElement>("[data-slot=sheet-content]");
    if (!element || !box || typeof ResizeObserver === "undefined") return;
    const follow = () => box.style.setProperty("--panel-head", `${element.offsetHeight}px`);
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div data-settings-panel={owner ? "owner" : "rules"}>
      {/* The title and "Close" stay in sight while the settings scroll under them. */}
      <div
        ref={head}
        data-panel-head
        className={cn(
          "sticky top-0 z-10 flex items-start gap-2 border-b border-line bg-surface py-2 pr-2 pl-4",
          side && "pt-[calc(0.5rem+env(safe-area-inset-top))]",
        )}
      >
        <SheetHeader className="flex-1 gap-1 px-0 py-2">
          <SheetTitle
            data-panel-title
            tabIndex={-1}
            className="text-xl font-[760] [font-stretch:110%] focus:outline-none"
          >
            {t(owner ? "settings.openOwner" : "settings.openOthers")}
          </SheetTitle>
          <SheetDescription className="text-ink-2">
            {t(owner ? "settings.ledeOwner" : "settings.ledeOthers")}
          </SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <XIcon aria-hidden />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </SheetClose>
      </div>
      <PanelLive />
      <div className="divide-y divide-line">
        {groups.map((group) => (
          <SettingsGroup key={group.id} group={group}>
            {group.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                room={room}
                settings={changes.shown}
                editable={owner}
                pending={changes.pending[field.key] !== undefined}
                failure={changes.failures[field.key] ?? null}
                change={(patch) => changes.change(field.key, patch)}
              />
            ))}
          </SettingsGroup>
        ))}
      </div>
    </div>
  );
}

/**
 * The table's live region, said again inside the panel: a modal dialog hides the page
 * from screen readers, so while it is open the table's announcements ("Voting started:
 * Round 1.", "Cards revealed.") are heard from here instead, each once.
 */
function PanelLive() {
  const said = useRoomStore((state) => state.said);
  const [since] = useState(() => useRoomStore.getState().said.id);
  return (
    <div role="status" data-panel-live className="sr-only">
      <span key={said.id}>{said.id > since ? said.text : ""}</span>
    </div>
  );
}

function SettingsGroup({ group, children }: { group: SettingGroup; children: ReactNode }) {
  const t = useT();
  const heading = useId();
  return (
    <section aria-labelledby={heading} data-settings-group={group.id} className="px-4 pt-3 pb-1">
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

/** What a refusal of `field` says: the offline case, the field's own words, or the generic ones. */
function refusalMessage(t: TFunction, field: SettingField, code: string): string {
  if (code === CONNECTION_DROPPED) return t("settings.connectionDropped");
  return field.refusals?.[code]?.(t) ?? failureMessage(t, code);
}

function FieldRow({ field, room, settings, editable, pending, failure, change }: FieldRowProps) {
  const t = useT();
  const format = useFormat();
  const ids = { control: useId(), label: useId(), hint: useId(), lock: useId(), error: useId() };
  const alert = useRef<HTMLParagraphElement>(null);
  const label = field.label(t);
  const detail = field.detail?.(t, settings, room) ?? null;
  const message = failure === null ? null : refusalMessage(t, field, failure);
  const { toggle, Control } = field;
  const lock = editable ? (toggle?.locked?.(room, t) ?? null) : null;

  // A refusal can land below the fold of a long panel: bring it into view.
  useEffect(() => {
    if (message !== null) alert.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);

  const props: ControlProps = {
    room,
    settings,
    change,
    pending,
    id: ids.control,
    labelId: ids.label,
    describedBy: [ids.hint, lock !== null && ids.lock, message !== null && ids.error]
      .filter(Boolean)
      .join(" "),
  };
  const control = !editable ? null : toggle ? (
    <SettingSwitch toggle={toggle} locked={lock !== null} {...props} />
  ) : Control ? (
    <Control {...props} />
  ) : null;
  const block = control !== null && field.layout === "block";

  const status = (
    <>
      {pending ? (
        <p data-setting-saving className="m-0 mt-1 text-sm text-ink-2">
          {t("settings.saving")}
        </p>
      ) : null}
      {lock !== null ? (
        <p id={ids.lock} data-setting-locked className="m-0 mt-1 flex items-start gap-2 text-sm">
          <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
          {lock}
        </p>
      ) : null}
      {message !== null ? (
        <p
          ref={alert}
          id={ids.error}
          role="alert"
          className="m-0 mt-2 flex scroll-my-4 items-start gap-2 text-sm text-ink"
        >
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {message}
        </p>
      ) : null}
    </>
  );

  return (
    <div
      data-setting={field.key}
      data-layout={block ? "block" : "inline"}
      data-pending={pending || undefined}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3"
    >
      <dt className={cn("font-medium", block && "col-span-2")}>
        {control !== null ? (
          <label id={ids.label} htmlFor={ids.control}>
            {label}
          </label>
        ) : (
          label
        )}
      </dt>
      {block ? null : (
        <dd
          data-setting-control={control !== null || undefined}
          className="col-start-2 row-span-2 row-start-1 m-0 flex max-w-44 justify-end pt-0.5 text-right"
        >
          {control ?? (
            <span data-setting-value className="font-semibold">
              {field.value(t, settings, format)}
            </span>
          )}
        </dd>
      )}
      <dd className={cn("m-0 text-sm text-ink-2", block && "col-span-2")}>
        <p id={ids.hint} className="m-0">
          {field.hint(t)}
        </p>
        {detail !== null ? (
          <p data-setting-detail className="m-0 mt-1 text-ink">
            {detail}
          </p>
        ) : null}
        {block ? null : status}
      </dd>
      {block ? (
        <dd data-setting-control className="col-span-2 m-0 pt-2">
          {control}
          {status}
        </dd>
      ) : null}
    </div>
  );
}
