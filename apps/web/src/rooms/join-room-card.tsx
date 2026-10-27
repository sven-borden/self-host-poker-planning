import { ROOM_CODE_LENGTH } from "@pp/domain";
import { useNavigate } from "@tanstack/react-router";
import { InfoIcon, OctagonXIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { parseRoomInput, type RoomInput } from "./room-input.ts";

/** A pasted link is cut here: far longer than any room link, far shorter than a flood. */
const INPUT_MAX_UNITS = 2048;

/** Stands in a message for an element rendered in its place (a private-use character). */
const SLOT = "\u{E000}";

/** The message with `node` where it holds `SLOT`. */
function withSlot(message: string, node: ReactNode): ReactNode {
  const [before, after = ""] = message.split(SLOT);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

type Problem = Exclude<RoomInput, { ok: true }>;

/**
 * "Join with a code" (#24): takes a bare code or a pasted room link (`parseRoomInput`),
 * checks its shape in the browser and opens `/r/:code`; whether the room exists is the
 * room page's question. A refused entry keeps the focus in the field with the message
 * linked to it. A room link for another host is not opened here: the card names that
 * host and offers its link. The field offers no history of earlier codes: no `name`,
 * autocomplete off.
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
  const [problem, setProblem] = useState<Problem | null>(null);
  const invalid = problem !== null && problem.reason !== "otherHost";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseRoomInput(value, window.location.host);
    if (!parsed.ok) {
      setProblem(parsed);
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {/* The hint and the message sit under the field, before the button on phones. */}
          <div className="flex flex-col gap-2 sm:flex-1">
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
              className="font-mono"
              aria-invalid={invalid || undefined}
              aria-describedby={problem ? `${ids.error} ${ids.hint}` : ids.hint}
            />
            <p id={ids.hint} className="text-sm text-ink-2">
              {t("join.hint", { length: ROOM_CODE_LENGTH })}
            </p>
            {problem && (
              <p id={ids.error} role="alert" className="flex items-start gap-2 text-sm">
                {problem.reason === "otherHost" ? (
                  <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
                ) : (
                  <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
                )}
                <span className="min-w-0 break-words">
                  <ProblemMessage problem={problem} />
                </span>
              </p>
            )}
          </div>
          <Button type="submit" variant={primary ? "default" : "outline"} className="sm:shrink-0">
            {t("join.submit")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ProblemMessage({ problem }: { problem: Problem }) {
  const t = useT();
  if (problem.reason === "otherHost") {
    // Another host: the same code there is another room, or none. Its link, as pasted
    // (only http or https reach here), opens that host rather than this one.
    return (
      <>
        {t("join.otherHost", { host: problem.host })}{" "}
        <a
          href={problem.href}
          rel="noopener noreferrer"
          className="font-medium text-ink underline underline-offset-4"
        >
          {t("join.openThere")}
        </a>
      </>
    );
  }
  if (problem.reason === "empty") return t("join.empty");
  // The four characters a code never holds, in Plex Mono: in Plex Sans, 0 and O, and I
  // and l, are two pairs of identical shapes.
  return withSlot(
    t("join.malformed", { length: ROOM_CODE_LENGTH, excluded: SLOT }),
    <code className="font-mono">{t("join.excluded")}</code>,
  );
}
