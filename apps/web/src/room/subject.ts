import { cardLength, cleanSubject, MAX_LINK_LENGTH, MAX_TITLE_LENGTH } from "@pp/domain";
import type { RoundView } from "@pp/protocol";
import type { TFunction } from "../i18n/i18n.ts";

// A round's subject (#21): what the PO's field turns into before `startRound`, and how
// a subject shows and is said. The browser checks with the domain's own rules
// (`cleanSubject`); the server decides, and reads a link's key itself.

/** A subject as the web sends it: never a link's `key`, which strict inbound objects refuse. */
export type OutgoingSubject =
  | { kind: "none" }
  | { kind: "title"; text: string }
  | { kind: "link"; url: string };

/** Why the field cannot start a round; the server's own `bad_subject` uses the same words. */
export type SubjectProblem = "titleTooLong" | "linkTooLong" | "badLink" | "bad_subject";

export type Draft = { ok: true; subject: OutgoingSubject } | { ok: false; problem: SubjectProblem };

/** Text that starts like a link: a scheme and `//`. */
const LINK_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Schemes that run or embed something, refused as links rather than kept as a title. */
const SCRIPT_SCHEME = /^(?:javascript|data|vbscript|file|blob):/i;
const WHITESPACE_RUN = /\s+/gu;

/**
 * The PO's field as a subject: empty is "Round N", a link (anything that starts like
 * one, or a script scheme) must be `http(s)` without credentials and at most 2,000
 * characters, anything else is a title of 1 to 200 characters under the domain's text
 * rules. Nothing is cut or stripped: a refusal says why.
 */
export function draftSubject(draft: string): Draft {
  const text = draft.trim();
  if (text === "") return { ok: true, subject: { kind: "none" } };
  if (LINK_LIKE.test(text) || SCRIPT_SCHEME.test(text)) {
    if (text.length > MAX_LINK_LENGTH) return { ok: false, problem: "linkTooLong" };
    return cleanSubject({ kind: "link", url: text }) === null
      ? { ok: false, problem: "badLink" }
      : { ok: true, subject: { kind: "link", url: text } };
  }
  const title = cleanSubject({ kind: "title", text });
  if (title?.kind === "title") return { ok: true, subject: title };
  return {
    ok: false,
    problem:
      cardLength(text.replace(WHITESPACE_RUN, " ")) > MAX_TITLE_LENGTH
        ? "titleTooLong"
        : "bad_subject",
  };
}

/** What a refusal says, in the reader's language. */
export function problemMessage(t: TFunction, problem: SubjectProblem): string {
  switch (problem) {
    case "titleTooLong":
      return t("round.titleTooLong", { max: MAX_TITLE_LENGTH });
    case "linkTooLong":
      return t("round.linkTooLong", { max: MAX_LINK_LENGTH });
    case "badLink":
      return t("round.badLink");
    case "bad_subject":
      return t("errors.bad_subject");
  }
}

/**
 * The link to render, or `null`: only an `http(s)` link without credentials that the
 * domain accepts becomes an `<a>`. The server already refuses anything else; this is
 * the page's own guard, so an old or odd snapshot can never make a `javascript:` link.
 */
export function safeHref(url: string): string | null {
  return cleanSubject({ kind: "link", url }) === null ? null : url;
}

/** A link's key as its chip reads: a Jira key as is, an Azure DevOps id as "#12345". */
export function keyLabel(key: string): string {
  return /^[0-9]+$/.test(key) ? `#${key}` : key;
}

/** At most this many characters of a link show; the full link is in its title. */
const SHORT_URL_LENGTH = 40;

/**
 * A link without a key, shortened: no scheme, no `www.`, no query or fragment, no
 * trailing slash, and at most 40 characters, the last one an ellipsis.
 */
export function shortUrl(url: string): string {
  const bare = url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/s, "")
    .replace(/\/+$/, "");
  return bare.length > SHORT_URL_LENGTH ? `${bare.slice(0, SHORT_URL_LENGTH - 1)}\u{2026}` : bare;
}

/**
 * How the live region names a round: its key ("ABC-123", "#12345"), its title, or
 * "Round N" (no subject, or a link without a key, which would read badly aloud).
 */
export function subjectName(t: TFunction, round: Pick<RoundView, "number" | "subject">): string {
  const { subject } = round;
  if (subject.kind === "title") return subject.text;
  if (subject.kind === "link" && subject.key !== undefined) return keyLabel(subject.key);
  return t("round.number", { round: round.number });
}
