import type { RoundView } from "@pp/protocol";
import { ExternalLinkIcon } from "lucide-react";
import { useT } from "../i18n/hooks.ts";
import { keyLabel, safeHref, shortUrl } from "./subject.ts";

/**
 * The round and its subject, above the table, for everyone (#21): "Round 3" alone, or
 * "Round 3" before the title (inside `<bdi>`, so a right-to-left title cannot reorder the
 * line; at most two lines, the whole title in its `title`) or before the link. A link
 * opens in a new tab with `rel="noopener noreferrer"` and shows as its key's chip
 * ("ABC-123", "#12345") or as a shortened URL, the full one in its title. Only an `http(s)` link without credentials becomes a link (`safeHref`).
 */
export function RoundSubject({ round }: { round: Pick<RoundView, "number" | "subject"> }) {
  const t = useT();
  const { subject } = round;
  const number = t("round.number", { round: round.number });
  if (subject.kind === "none") {
    return (
      <p data-round-subject="none" className={`${LINE} items-center`}>
        <span className="font-semibold">{number}</span>
      </p>
    );
  }
  return (
    <p
      data-round-subject={subject.kind}
      // A title of two lines keeps "Round 3" on its first line.
      className={`${LINE} ${subject.kind === "title" ? "items-baseline" : "items-center"}`}
    >
      <span className="shrink-0 text-ink-2">{number}</span>
      {subject.kind === "title" ? (
        <bdi
          data-subject-title
          title={subject.text}
          className="line-clamp-2 min-w-0 font-semibold break-words"
        >
          {subject.text}
        </bdi>
      ) : (
        <SubjectLink url={subject.url} linkKey={subject.key} />
      )}
    </p>
  );
}

const LINE = "m-0 mb-3 flex min-w-0 justify-center gap-2 text-sm";

function SubjectLink({ url, linkKey }: { url: string; linkKey: string | undefined }) {
  const t = useT();
  const href = safeHref(url);
  if (href === null) {
    return (
      <bdi data-subject-text className="min-w-0 truncate">
        {shortUrl(url)}
      </bdi>
    );
  }
  return (
    <a
      data-subject-link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 font-medium text-ink underline-offset-2 hover:underline phone:min-h-11"
    >
      {linkKey !== undefined ? (
        <span data-subject-key className="font-mono text-[13px] font-semibold text-spruce">
          {keyLabel(linkKey)}
        </span>
      ) : (
        <bdi className="min-w-0 truncate">{shortUrl(url)}</bdi>
      )}
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0 text-ink-2" />
      {/* The space keeps the key and this note apart in the link's name. */}{" "}
      <span className="sr-only">{t("round.opensInNewTab")}</span>
    </a>
  );
}
