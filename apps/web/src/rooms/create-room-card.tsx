import { MAX_ROOM_NAME_LENGTH, PRESET_DECK_IDS, PRESET_DECKS, type PresetDeckId } from "@pp/domain";
import { useNavigate } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import type { MessageKey, TFunction } from "../i18n/i18n.ts";
import { COOKIES_BLOCKED } from "../identity/identity.ts";
import { cn } from "../lib/utils.ts";
import { createRoom } from "./api.ts";

/** The catalog key of each preset's name. */
export const DECK_NAMES = {
  fib: "decks.fib",
  mfib: "decks.mfib",
  tshirt: "decks.tshirt",
  pow2: "decks.pow2",
  seq: "decks.seq",
} as const satisfies Record<PresetDeckId, MessageKey>;

/** The default deck of a new room (ADR-011). */
const DEFAULT_DECK: PresetDeckId = "fib";

/** What went wrong, for the reader: the server's code, or the browser's own trouble. */
function failureMessage(t: TFunction, error: unknown): string {
  const code =
    typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
      ? (Reflect.get(error, "code") as string)
      : "unknown";
  if (code === "network") return t("common.network");
  if (code === COOKIES_BLOCKED) return t("identity.cookiesBlocked");
  return errorMessage(t, code);
}

/**
 * "Create a room" (#14): an optional room name and a preset deck, Fibonacci by default.
 * Submitting makes sure this browser has a guest, creates the room (the guest becomes its
 * product owner) and opens `/r/:code`. Self-contained, so the landing page (#24) can place
 * it anywhere.
 */
export function CreateRoomCard({ className }: { className?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const ids = { heading: useId(), name: useId(), hint: useId(), error: useId() };
  const [name, setName] = useState("");
  const [deck, setDeck] = useState<PresetDeckId>(DEFAULT_DECK);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; nameRefused: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const code = await createRoom({ name, deck });
      await navigate({ to: "/r/$code", params: { code } });
    } catch (error) {
      const nameRefused = Reflect.get(Object(error), "code") === "bad_room_name";
      setFailure({ message: failureMessage(t, error), nameRefused });
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={ids.heading}
      className={cn("max-w-xl rounded-xl border border-line bg-surface p-5 sm:p-7", className)}
    >
      <h2 id={ids.heading} className="text-2xl font-[760] [font-stretch:110%]">
        {t("home.createRoom")}
      </h2>
      <p className="mt-2 text-ink-2">{t("createRoom.lede")}</p>
      <form className="mt-6 flex flex-col gap-6" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={ids.name} className="font-medium">
              {t("createRoom.nameLabel")}
            </label>
            <span className="font-mono text-xs tracking-[0.06em] text-ink-2 uppercase">
              {t("createRoom.optional")}
            </span>
          </div>
          <Input
            id={ids.name}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            enterKeyHint="go"
            aria-invalid={failure?.nameRefused || undefined}
            aria-describedby={failure?.nameRefused ? `${ids.error} ${ids.hint}` : ids.hint}
          />
          <p id={ids.hint} className="text-sm text-ink-2">
            {t("createRoom.nameHint", { max: MAX_ROOM_NAME_LENGTH })}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">{t("createRoom.deckLabel")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PRESET_DECK_IDS.map((id) => (
              <label
                key={id}
                data-deck={id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors",
                  "hover:bg-surface-2 has-checked:border-spruce has-checked:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="deck"
                  value={id}
                  checked={deck === id}
                  onChange={() => setDeck(id)}
                  className="mt-1 size-4 shrink-0 accent-spruce"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{t(DECK_NAMES[id])}</span>
                  <span className="font-mono text-xs break-words text-ink-2">
                    {PRESET_DECKS[id].join(" ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {failure && (
          <p id={ids.error} role="alert" className="flex items-start gap-2 text-sm">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {failure.message}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full sm:w-auto sm:self-start" disabled={busy}>
          {busy ? t("createRoom.creating") : t("createRoom.submit")}
        </Button>
      </form>
    </section>
  );
}
