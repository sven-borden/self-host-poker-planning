import {
  type DeckSpec,
  MAX_CARD_LENGTH,
  MAX_DECK_CARDS,
  PRESET_DECK_IDS,
  PRESET_DECKS,
  type PresetDeckId,
  type RangeErrorCode,
  SPECIAL_CARDS,
  type SpecialCard,
} from "@pp/domain";
import type { RoomView } from "@pp/protocol";
import { ChevronDownIcon, OctagonXIcon, RotateCcwIcon } from "lucide-react";
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { useFormat, useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { cn } from "../lib/utils.ts";
import { MiniCard } from "../table/cards.tsx";
import {
  cardsText,
  checkCustomDeck,
  deckProblemMessage,
  rangeCards,
  rangeProblemMessage,
  splitCards,
} from "./deck-editor.ts";
import type { ControlProps } from "./settings-panel.tsx";
import { deckInSentence } from "./settings-words.ts";

// The deck and the special cards in the PO's settings panel (#26): the first `Control`s
// plugged into the panel's contract (`ControlProps`, `layout: "block"`). Part of the
// panel's lazy chunk. A deck is chosen, then applied with a button: an arrow key in the
// radio group only moves the choice, so a keyboard never sends five deck changes, or
// five restart questions, on its way to the sixth deck. The special cards are switches.
// During Voting with a vote cast, either change asks first: it restarts the round.

type Choice = PresetDeckId | "custom";

const choiceOf = (deck: DeckSpec): Choice => (deck.kind === "custom" ? "custom" : deck.id);

/** The round a change applies from: the next one, or the one on the table when Voting. */
function roundOfChange(room: RoomView): number {
  const round = room.round;
  if (round === null) return 1;
  return round.phase === "voting" ? round.number : round.number + 1;
}

/** The round a change would restart, and its votes, when it holds any: ask first then. */
function restartToAsk(room: RoomView): { round: number; count: number } | null {
  const round = room.round;
  if (round?.phase !== "voting" || round.voted.length === 0) return null;
  return { round: round.number, count: round.voted.length };
}

/** When new cards (a deck or the special cards) take effect, said once, in the deck field. */
function WhenLine({ room }: { room: RoomView }) {
  const t = useT();
  const round = roundOfChange(room);
  return (
    <p data-change-applies className="m-0 mb-3 text-sm text-ink-2">
      {room.round?.phase === "voting"
        ? t("deckField.restartsRound", { round })
        : t("deckField.fromNextRound", { round })}
    </p>
  );
}

/**
 * "Changing the deck restarts round 4. The 3 votes cast so far are cleared; the subject
 * stays." Inline in the field, with the restart and "Cancel"; it takes the focus when it
 * shows, so a screen reader reads the question.
 */
function RestartQuestion({
  text,
  confirm,
  onConfirm,
  onCancel,
  leftWithFocus,
}: {
  text: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Set when the question goes while the focus is inside it (Cancel, or the votes went). */
  leftWithFocus: RefObject<boolean>;
}) {
  const t = useT();
  const question = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  // A layout cleanup runs before React removes the box, while the focus is still inside.
  useLayoutEffect(() => {
    const element = box.current;
    leftWithFocus.current = false;
    return () => {
      leftWithFocus.current = element?.contains(document.activeElement) ?? false;
    };
  }, [leftWithFocus]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, focused as one block, hold no form field to group
    <div
      ref={box}
      tabIndex={-1}
      role="group"
      aria-labelledby={question}
      data-restart-question
      className="mt-3 scroll-my-4 rounded-lg border border-warn bg-surface-2 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p id={question} className="m-0 flex items-start gap-2">
        <RotateCcwIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warn-ink" />
        {text}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={onConfirm}>
          {confirm}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("deckField.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** A line of mini cards: a preview of the deck the field holds. */
function CardPreview({ cards, fault }: { cards: readonly string[]; fault?: string | number }) {
  return (
    <div aria-hidden="true" data-deck-preview className="flex flex-wrap gap-1">
      {cards.map((card, i) => {
        const faulty = fault === card || fault === i + 1;
        return (
          // Labels repeat while the PO types (a duplicate is the error being shown).
          // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here
          <span key={i} data-fault={faulty || undefined} className="contents">
            <MiniCard value={card} className={cn(faulty && "ring-2 ring-bad ring-offset-1")} />
          </span>
        );
      })}
    </div>
  );
}

/**
 * The deck (#26): a radio group of the presets and "Custom deck", each preset with its
 * cards, and a button that applies the choice. "Custom deck" opens a field for the cards,
 * separated by commas, with a live preview, each problem in plain words, and a range
 * generator that fills it.
 */
export function DeckControl({
  room,
  settings,
  change,
  pending,
  id,
  labelId,
  describedBy,
}: ControlProps) {
  const t = useT();
  const current = choiceOf(settings.deck);
  const [choice, setChoice] = useState<Choice>(current);
  const [text, setTextNow] = useState(() =>
    settings.deck.kind === "custom" ? cardsText(settings.deck.cards) : "",
  );
  const [asking, setAsking] = useState<DeckSpec | null>(null);
  const radios = useRef(new Map<Choice, HTMLInputElement>());
  const applyButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const questionLeftWithFocus = useRef(false);
  const name = useId();

  // A question is about one deck: edit the cards and it no longer holds, so it goes.
  function setText(next: string) {
    setTextNow(next);
    setAsking(null);
  }

  // The room's deck moved (confirmed, or rolled back by a refusal): the choice follows it.
  useEffect(() => {
    setChoice(current);
    setAsking(null);
  }, [current]);

  const check = checkCustomDeck(text);
  const typed = splitCards(text);
  // The cards in the field are the room's deck already: "Use these cards" does nothing.
  const inUse =
    check.ok &&
    settings.deck.kind === "custom" &&
    check.cards.join("\n") === settings.deck.cards.join("\n");

  function apply(deck: DeckSpec) {
    if (pending) return;
    if (restartToAsk(room) !== null) {
      setAsking(deck);
      return;
    }
    send(deck);
  }

  function send(deck: DeckSpec) {
    setAsking(null);
    change({ deck });
    // A preset's apply button goes once the choice is the room's deck: the focus moves to
    // its radio. The custom field's button stays.
    if (deck.kind === "preset") radios.current.get(deck.id)?.focus();
    else applyButton.current?.focus();
  }

  function applyCustom() {
    if (!check.ok) {
      field.current?.focus();
      return;
    }
    if (inUse) return;
    apply({ kind: "custom", cards: check.cards });
  }

  const chosenPreset = choice === "custom" ? null : choice;
  const ask = restartToAsk(room);
  // The question shows while the round it would restart still holds votes.
  const question = asking !== null && ask !== null;

  // The question went with the focus inside it (Cancel, the votes went, the deck moved):
  // the focus goes to the apply button, or to the chosen deck's radio when the button
  // went too, never to the dialog.
  useLayoutEffect(() => {
    if (question || !questionLeftWithFocus.current) return;
    questionLeftWithFocus.current = false;
    (applyButton.current ?? radios.current.get(choice))?.focus();
  });

  return (
    <div data-deck-field>
      <WhenLine room={room} />
      <div
        id={id}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        className="grid gap-2"
        data-deck-choices
      >
        {[...PRESET_DECK_IDS, "custom" as const].map((option) => (
          <DeckOption
            key={option}
            option={option}
            name={name}
            checked={choice === option}
            inUse={option === current}
            input={(input) => {
              if (input) radios.current.set(option, input);
              else radios.current.delete(option);
            }}
            onChoose={() => {
              setChoice(option);
              setAsking(null);
            }}
          />
        ))}
      </div>
      {choice === "custom" ? (
        <CustomEditor
          text={text}
          setText={setText}
          check={check}
          typed={typed}
          field={field}
          onApply={applyCustom}
          applyButton={applyButton}
          pending={pending}
          inUse={inUse}
        />
      ) : null}
      {chosenPreset !== null && chosenPreset !== current && !question ? (
        <Button
          ref={applyButton}
          type="button"
          className="mt-3 aria-disabled:opacity-60"
          aria-disabled={pending || undefined}
          data-deck-apply
          onClick={() => apply({ kind: "preset", id: chosenPreset })}
        >
          {t("deckField.use", {
            deck: deckInSentence(t, { kind: "preset", id: chosenPreset }),
          })}
        </Button>
      ) : null}
      {question ? (
        <RestartQuestion
          text={t("deckField.deckQuestion", ask)}
          confirm={t("deckField.restartWith", { deck: deckInSentence(t, asking) })}
          onConfirm={() => send(asking)}
          onCancel={() => setAsking(null)}
          leftWithFocus={questionLeftWithFocus}
        />
      ) : null}
    </div>
  );
}

/**
 * One deck in the radio group: its name is the radio's name; whether the room plays it
 * now and its cards describe it.
 */
function DeckOption({
  option,
  name,
  checked,
  inUse,
  input,
  onChoose,
}: {
  option: Choice;
  name: string;
  checked: boolean;
  inUse: boolean;
  input: (element: HTMLInputElement | null) => void;
  onChoose: () => void;
}) {
  const t = useT();
  const ids = { name: useId(), inUse: useId(), cards: useId() };
  const describedBy = [inUse && ids.inUse, option !== "custom" && ids.cards]
    .filter(Boolean)
    .join(" ");
  return (
    <label
      data-deck={option}
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2 transition-colors",
        "hover:bg-surface-2 has-checked:border-spruce has-checked:bg-surface-2",
      )}
    >
      <input
        ref={input}
        type="radio"
        name={name}
        value={option}
        checked={checked}
        aria-labelledby={ids.name}
        aria-describedby={describedBy || undefined}
        onChange={onChoose}
        className="mt-1 size-4 shrink-0 accent-spruce"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span id={ids.name} className="font-medium">
            {option === "custom" ? t("decks.custom") : t(`decks.${option}`)}
          </span>
          {inUse ? (
            <span
              id={ids.inUse}
              data-deck-in-use
              className="font-mono text-xs tracking-[0.06em] text-spruce uppercase"
            >
              {t("deckField.inUse")}
            </span>
          ) : null}
        </span>
        {option === "custom" ? null : (
          <span id={ids.cards} className="font-mono text-xs break-words text-ink-2">
            {PRESET_DECKS[option].join(" ")}
          </span>
        )}
      </span>
    </label>
  );
}

interface CustomEditorProps {
  text: string;
  setText: (text: string) => void;
  check: ReturnType<typeof checkCustomDeck>;
  typed: readonly string[];
  field: React.RefObject<HTMLInputElement | null>;
  applyButton: React.RefObject<HTMLButtonElement | null>;
  onApply: () => void;
  pending: boolean;
  /** The field holds the room's deck already: applying it is a no-op. */
  inUse: boolean;
}

function CustomEditor({
  text,
  setText,
  check,
  typed,
  field,
  applyButton,
  onApply,
  pending,
  inUse,
}: CustomEditorProps) {
  const t = useT();
  const ids = { field: useId(), hint: useId(), error: useId(), count: useId() };
  // An empty field is not an error until the PO tries to use it. Each try counts, so a
  // problem said again after another Enter is a new alert a screen reader reads.
  const [tried, setTried] = useState(false);
  const [tries, setTries] = useState(0);
  function tryApply() {
    setTried(true);
    setTries((was) => was + 1);
    onApply();
  }
  const problem =
    check.ok || (check.problem.code === "deck_empty" && !tried) ? null : check.problem;
  const cards = check.ok ? check.cards : typed.filter((card) => card !== "");
  // The preview stops at the most a deck holds; the count and the problem say the rest.
  const shown = cards.slice(0, MAX_DECK_CARDS);
  const fault =
    problem === null
      ? undefined
      : "card" in problem
        ? problem.card
        : "position" in problem
          ? problem.position
          : undefined;
  return (
    <div data-custom-deck className="mt-3 grid gap-2">
      <label htmlFor={ids.field} className="font-medium">
        {t("deckField.customLabel")}
      </label>
      <p id={ids.hint} className="m-0 text-sm text-ink-2">
        {t("deckField.customHint", { max: MAX_DECK_CARDS, length: MAX_CARD_LENGTH })}
      </p>
      <Input
        ref={field}
        id={ids.field}
        value={text}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null || undefined}
        aria-describedby={[ids.hint, ids.count, problem !== null && ids.error]
          .filter(Boolean)
          .join(" ")}
        onChange={(event) => {
          setText(event.target.value);
          setTried(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          tryApply();
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CardPreview cards={shown} fault={fault} />
        <span id={ids.count} data-deck-count className="text-sm text-ink-2">
          {t("deckField.customCount", { count: cards.length })}
        </span>
      </div>
      {problem !== null ? (
        <p
          // A new alert for each try: typing stays quiet, Enter or the button speaks.
          key={tried ? tries : "typing"}
          id={ids.error}
          role={tried ? "alert" : undefined}
          data-deck-problem
          className="m-0 flex items-start gap-2 text-sm"
        >
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {deckProblemMessage(t, problem)}
        </p>
      ) : null}
      <RangeGenerator onFill={(cards) => setText(cardsText(cards))} />
      <Button
        ref={applyButton}
        type="button"
        className="justify-self-start aria-disabled:opacity-60"
        aria-disabled={pending || inUse || undefined}
        data-deck-apply
        onClick={tryApply}
      >
        {t("deckField.useCustom")}
      </Button>
    </div>
  );
}

/**
 * Start, end and step under a disclosure: "Fill in the cards" puts `generateRange`'s
 * cards in the custom field, where the PO can still edit them. The inputs take "," or "."
 * as the decimal mark: they are numbers, not labels.
 */
function RangeGenerator({ onFill }: { onFill: (cards: readonly string[]) => void }) {
  const t = useT();
  const format = useFormat();
  const ids = {
    region: useId(),
    start: useId(),
    end: useId(),
    step: useId(),
    hint: useId(),
    error: useId(),
  };
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(() => ({
    start: format.number(0),
    end: format.number(5),
    step: format.number(0.5),
  }));
  const [error, setError] = useState<RangeErrorCode | null>(null);
  const [filled, setFilled] = useState<{ count: number; id: number } | null>(null);
  const describedBy = [ids.hint, error !== null && ids.error].filter(Boolean).join(" ");
  const inputs = [
    ["start", ids.start, "deckField.rangeStart"],
    ["end", ids.end, "deckField.rangeEnd"],
    ["step", ids.step, "deckField.rangeStep"],
  ] as const;

  return (
    <div data-range>
      <Button
        type="button"
        variant="ghost"
        className="-ml-3 gap-1"
        aria-expanded={open}
        aria-controls={ids.region}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
        {t("deckField.rangeOpen")}
      </Button>
      <div
        id={ids.region}
        hidden={!open}
        className="mt-1 grid gap-2 rounded-lg border border-line p-3"
      >
        <div className="grid grid-cols-3 gap-2">
          {inputs.map(([key, inputId, label]) => (
            <div key={key} className="grid min-w-0 gap-1">
              <label htmlFor={inputId} className="text-sm font-medium">
                {t(label)}
              </label>
              <Input
                id={inputId}
                data-range-input={key}
                inputMode="decimal"
                autoComplete="off"
                value={input[key]}
                aria-invalid={error !== null || undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  const value = event.target.value;
                  setInput((was) => ({ ...was, [key]: value }));
                  setError(null);
                }}
              />
            </div>
          ))}
        </div>
        <p id={ids.hint} className="m-0 text-sm text-ink-2">
          {t("deckField.rangeHint")}
        </p>
        {error !== null ? (
          <p
            id={ids.error}
            role="alert"
            data-range-problem
            className="m-0 flex items-start gap-2 text-sm"
          >
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {rangeProblemMessage(t, error)}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            const range = rangeCards(input);
            if (!range.ok) {
              setError(range.code);
              setFilled(null);
              return;
            }
            setError(null);
            onFill(range.cards);
            setFilled((was) => ({ count: range.cards.length, id: (was?.id ?? 0) + 1 }));
          }}
        >
          {t("deckField.rangeFill")}
        </Button>
        <p role="status" data-range-filled className="m-0 text-sm text-ink-2">
          <span key={filled?.id}>
            {filled !== null ? t("deckField.rangeFilled", { count: filled.count }) : ""}
          </span>
        </p>
      </div>
    </div>
  );
}

const SPECIAL_WORDS: Record<SpecialCard, (t: TFunction) => string> = {
  "?": (t) => t("deckField.specialUnsure"),
  "☕": (t) => t("deckField.specialCoffee"),
  "∞": (t) => t("deckField.specialInfinite"),
};

/**
 * The special cards (#26): a switch for each, with what it means. A change during Voting
 * with a vote cast asks first, as the deck does: it restarts the round.
 */
export function SpecialsControl({
  room,
  settings,
  change,
  pending,
  id,
  labelId,
  describedBy,
}: ControlProps) {
  const t = useT();
  const [asking, setAsking] = useState<{ specials: SpecialCard[]; from: SpecialCard } | null>(null);
  const switches = useRef(new Map<SpecialCard, HTMLButtonElement>());
  const names = { "?": useId(), "☕": useId(), "∞": useId() } as const;
  const ask = restartToAsk(room);
  const question = asking !== null && ask !== null;
  const questionLeftWithFocus = useRef(false);
  const lastFrom = useRef<SpecialCard>("?");
  if (asking !== null) lastFrom.current = asking.from;

  // The question went with the focus inside it (the votes went): back to its switch.
  useLayoutEffect(() => {
    if (question || !questionLeftWithFocus.current) return;
    questionLeftWithFocus.current = false;
    switches.current.get(lastFrom.current)?.focus();
  });

  function toggle(card: SpecialCard, on: boolean) {
    if (pending) return;
    const specials = SPECIAL_CARDS.filter((s) => (s === card ? on : settings.specials.includes(s)));
    if (ask !== null) {
      setAsking({ specials, from: card });
      return;
    }
    change({ specials });
  }

  return (
    <div data-specials-field>
      <fieldset id={id} aria-labelledby={labelId} className="m-0 grid min-w-0 gap-1 border-0 p-0">
        {SPECIAL_CARDS.map((card) => (
          <div key={card} data-special={card} className="flex min-h-11 items-center gap-3">
            <MiniCard value={card} />
            <span id={names[card]} className="flex-1">
              {SPECIAL_WORDS[card](t)}
            </span>
            <Switch
              ref={(element) => {
                if (element) switches.current.set(card, element);
                else switches.current.delete(card);
              }}
              checked={settings.specials.includes(card)}
              aria-labelledby={names[card]}
              aria-describedby={describedBy}
              aria-busy={pending || undefined}
              aria-disabled={pending || undefined}
              className="relative after:absolute after:-inset-x-2 after:-inset-y-3.5 aria-disabled:opacity-60"
              onCheckedChange={(on) => toggle(card, on)}
            />
          </div>
        ))}
      </fieldset>
      {question ? (
        <RestartQuestion
          text={t("deckField.specialsQuestion", ask)}
          confirm={t("deckField.restartSpecials")}
          onConfirm={() => {
            const { specials, from } = asking;
            setAsking(null);
            change({ specials });
            switches.current.get(from)?.focus();
          }}
          onCancel={() => {
            const { from } = asking;
            setAsking(null);
            switches.current.get(from)?.focus();
          }}
          leftWithFocus={questionLeftWithFocus}
        />
      ) : null}
    </div>
  );
}
