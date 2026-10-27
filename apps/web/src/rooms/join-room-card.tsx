import { ROOM_CODE_LENGTH } from "@pp/domain";
import { useNavigate } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { parseRoomInput } from "./room-input.ts";

/** A pasted link is cut here: far longer than any room link, far shorter than a flood. */
const INPUT_MAX_UNITS = 2048;

/**
 * "Join with a code" (#24): takes a bare code or a pasted room link (`parseRoomInput`),
 * checks its shape in the browser and opens `/r/:code`; whether the room exists is the
 * room page's question. A refused entry keeps the focus in the field with the error linked
 * to it. The field offers no history of earlier codes: no `name`, autocomplete off.
 */
export function JoinRoomCard({
  title,
  primary = false,
  className,
}: {
  /** The card's heading: "Join with a code" on `/`, "Try another code" on a missing room. */
  title: string;
  /** A spruce button when joining is the page's main action. */
  primary?: boolean;
  className?: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const ids = { heading: useId(), field: useId(), hint: useId(), error: useId() };
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<"empty" | "malformed" | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseRoomInput(value);
    if (!parsed.ok) {
      setProblem(parsed.reason);
      field.current?.focus();
      return;
    }
    setProblem(null);
    setValue("");
    await navigate({ to: "/r/$code", params: { code: parsed.code } });
  }

  return (
    <section
      aria-labelledby={ids.heading}
      className={cn("rounded-xl border border-line bg-surface p-5 sm:p-7", className)}
    >
      <h2 id={ids.heading} className="text-xl font-[760] [font-stretch:110%]">
        {title}
      </h2>
      <form className="mt-4 flex flex-col gap-2" onSubmit={submit} noValidate>
        <label htmlFor={ids.field} className="font-medium">
          {t("join.label")}
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            ref={field}
            id={ids.field}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={INPUT_MAX_UNITS}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="font-mono sm:flex-1"
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem ? `${ids.error} ${ids.hint}` : ids.hint}
          />
          <Button type="submit" variant={primary ? "default" : "outline"} className="sm:shrink-0">
            {t("join.submit")}
          </Button>
        </div>
        <p id={ids.hint} className="text-sm text-ink-2">
          {t("join.hint", { length: ROOM_CODE_LENGTH })}
        </p>
        {problem && (
          <p id={ids.error} role="alert" className="flex items-start gap-2 text-sm">
            <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
            {problem === "empty"
              ? t("join.empty")
              : t("join.malformed", { length: ROOM_CODE_LENGTH })}
          </p>
        )}
      </form>
    </section>
  );
}
