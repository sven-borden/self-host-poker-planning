/**
 * A round's subject as a client sends it with `startRound` (#21): nothing, a title or a
 * link, checked at runtime like every other input (`apply-input.ts`), and a link's issue
 * key read here, so only the server sets it. A module of its own: the web uses it in the
 * room, and the join form's `cleanName` stays light without it.
 */
import { cleanText, isRecord } from "./apply-input.ts";
import { MAX_LINK_LENGTH, MAX_TITLE_LENGTH, type Subject } from "./room.ts";

/**
 * An `http(s)` URL with a non-empty host and no user info (`https://a.com@b.com` would
 * hide the real host), without whitespace, control or format characters. Checked by
 * pattern: the domain has no `URL`.
 */
const LINK = /^https?:\/\/[^\s\p{Cc}\p{Cf}/?#@\\]+(?:[/?#][^\s\p{Cc}\p{Cf}]*)?$/iu;

/**
 * A round subject, cleaned, or `null` (`bad_subject`). A client-sent link `key` is
 * dropped; the link's own key is detected here (`linkKey`), which on the wire means by the
 * server, since only the server runs `apply`.
 */
export function cleanSubject(raw: unknown): Subject | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "title") {
    const text = cleanText(raw.text, MAX_TITLE_LENGTH);
    return text === null ? null : { kind: "title", text };
  }
  if (raw.kind === "link" && typeof raw.url === "string") {
    const url = raw.url.trim();
    if (url.length > MAX_LINK_LENGTH || !url.isWellFormed() || !LINK.test(url)) return null;
    const key = linkKey(url);
    return key === null ? { kind: "link", url } : { kind: "link", url, key };
  }
  return null;
}

/** A link cut into its host, its path and its query (after the `?`, without it). */
const URL_PARTS = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i;
/**
 * A Jira issue key: a project key (a letter, then letters, digits or `_`, 2 to 32
 * characters in all), a dash and the issue's number (no leading zero). Read in any case
 * and stored in capitals, as Jira writes it.
 */
const JIRA_KEY = "[A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,9}";
/**
 * `…/browse/ABC-123`, or Jira Cloud's `…/projects/ABC/issues/ABC-123`, at the end of the
 * path; a context path such as `/jira` may precede it.
 */
const JIRA_PATH = new RegExp(`/(?:browse|projects/[^/]+/issues)/(${JIRA_KEY})/?$`, "i");
/** `selectedIssue=ABC-123` in the query, as a Jira board or backlog links an issue. */
const JIRA_SELECTED = new RegExp(`(?:^|&)selectedIssue=(${JIRA_KEY})(?:&|$)`, "i");
/** An Azure DevOps work item id: a positive number of at most 10 digits. */
const ADO_ID = "[1-9][0-9]{0,9}";
/**
 * `…/_workitems/edit/{id}` after one to three path segments: `dev.azure.com/{org}/{project}`,
 * `{org}.visualstudio.com/[{collection}/]{project}`, or an Azure DevOps Server's
 * `[{virtual directory}/]{collection}/{project}`, on its own host.
 */
const ADO_PATH = new RegExp(`^(?:/[^/]+){1,3}/_workitems/edit/(${ADO_ID})/?$`, "i");
/** `workitem=12345` in the query, as an Azure DevOps board or backlog opens one. */
const ADO_QUERY = new RegExp(`(?:^|&)workitem=(${ADO_ID})(?:&|$)`, "i");
/** Azure DevOps Services' own hosts, where a `workitem=` query is read. */
const ADO_HOST = /^(?:dev\.azure\.com|[a-z0-9][a-z0-9-]*\.visualstudio\.com)$/i;

/**
 * The issue a link points at, for its chip; else `null`. A Jira key ("ABC-123", from
 * `/browse/ABC-123`, `/projects/ABC/issues/ABC-123` or `selectedIssue=ABC-123`), on any
 * host since Jira is often self-hosted, in capitals. An Azure DevOps work item id
 * ("12345") from `…/_workitems/edit/12345` on any host (Azure DevOps Server is
 * self-hosted too), or from `workitem=12345` on `dev.azure.com` or `*.visualstudio.com`.
 * A key with a letter is Jira's, digits alone are an Azure DevOps id. Read by pattern,
 * like the link itself: the domain has no `URL`.
 */
export function linkKey(url: string): string | null {
  const parts = URL_PARTS.exec(url);
  if (parts === null) return null;
  // Both groups always match, if only the empty string; `String` keeps the types honest.
  const host = String(parts[1]);
  const path = String(parts[2]);
  const query = parts[3] ?? "";
  const jira = JIRA_PATH.exec(path) ?? JIRA_SELECTED.exec(query);
  if (jira !== null) return String(jira[1]).toUpperCase();
  const ado = ADO_PATH.exec(path) ?? (ADO_HOST.test(host) ? ADO_QUERY.exec(query) : null);
  return ado === null ? null : String(ado[1]);
}
