import {
  MAX_LINK_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_ITEMS,
  MAX_TITLE_LENGTH,
  queueBytes,
  queueIdentity,
} from "@pp/domain";
import { describe, expect, it } from "vitest";
import { parsePaste, pasteLeft, queueBatches, tableRows } from "./paste-queue.ts";

// The samples below are RECONSTRUCTED, not copied from a live board or a real clipboard: nobody
// here has a Jira or an Azure DevOps, and the issue's first acceptance criterion waits for real
// ones. Tabs and line breaks are written out so that an editor cannot change them. What each
// sample rests on, and what it does not:
//
// - JIRA_SERVER: the columns are Jira Data Center's documented defaults for the issue navigator's
//   list view (T, Key, Summary, Assignee, Reporter, P, Status, Resolution, Created, Updated).
//   That a browser's copy of it gives tabs, and empty cells for the icon columns, is assumed.
// - JIRA_CLOUD: no copy from Jira. Atlassian's JSDCLOUD-18884 says the bulk copy action is gone
//   from the unified List view and suggests a CSV export: this is such an export opened in a
//   sheet and copied from there, with its columns assumed.
// - JIRA_GERMAN: JIRA_SERVER under column names assumed for a German Jira.
// - ADO_QUERY: a guess. Microsoft's "Copy or clone work items" says only "HTML-formatted table"
//   ("Copy as HTML"), and a textarea gets the plain-text flavour, which nobody here has seen. The
//   header row, the tabs and the columns are all assumed.
// - ADO_QUOTED: ADO_QUERY with a title of two lines, quoted by RFC 4180's rule with tabs, as
//   spreadsheets write it. Whether a browser or Azure DevOps ever writes quoted cells is unverified.
// - ADO_BACKLOG: a guess at a backlog's copy, with the order and points columns first.
const JIRA_SERVER = [
  "T\tKey\tSummary\tAssignee\tReporter\tP\tStatus\tResolution\tCreated\tUpdated",
  "\tPAY-482\tCheckout fails on expired card\tAna Lima\tBen Roth\t\tTo Do\tUnresolved\t12/Oct/26\t14/Oct/26",
  "\tPAY-483\tRefund email shows the wrong currency\tBen Roth\tBen Roth\t\tIn Progress\tUnresolved\t12/Oct/26\t15/Oct/26",
  "\tWEB-77\tLogin page: keep the language after a redirect\t\tCleo Marin\t\tTo Do\tUnresolved\t13/Oct/26\t13/Oct/26",
].join("\r\n");

const JIRA_CLOUD = [
  "Type\tKey\tSummary\tStatus\tAssignee",
  "Story\tPAY-482\tCheckout fails on expired card\tTO DO\tAna Lima",
  "Bug\tPAY-483\tRefund email shows the wrong currency\tIN PROGRESS\tBen Roth",
].join("\n");

const JIRA_GERMAN = [
  "T\tSchlüssel\tZusammenfassung\tBearbeiter\tStatus",
  "\tPAY-482\tZahlung schlägt bei abgelaufener Karte fehl\tAna Lima\tOffen",
].join("\n");

const ADO_QUERY = [
  "ID\tWork Item Type\tTitle\tAssigned To\tState\tTags",
  "1234\tUser Story\tExport the sprint as CSV\tAna Lima <ana@example.com>\tNew\t",
  "1235\tBug\tBoard drops the filter on reload\t\tActive\tweb; p1",
].join("\r\n");

const ADO_QUOTED = [
  "ID\tTitle\tState",
  '1234\t"Export the sprint\nas CSV, ""quoted"" too"\tNew',
  "1235\tBoard drops the filter\tActive",
].join("\n");

const ADO_BACKLOG = [
  "Order\tWork Item Type\tTitle\tState\tStory Points\tID",
  "1\tProduct Backlog Item\tExport the sprint as CSV\tNew\t5\t1234",
  "2\tBug\tBoard drops the filter on reload\tApproved\t3\t1235",
].join("\n");

const entries = (text: string) => parsePaste(text).items;

describe("reconstructed list samples", () => {
  it("reads Jira's issue navigator, on a server and in the cloud", () => {
    const server = parsePaste(JIRA_SERVER);
    expect(server.items).toEqual([
      { key: "PAY-482", title: "Checkout fails on expired card" },
      { key: "PAY-483", title: "Refund email shows the wrong currency" },
      { key: "WEB-77", title: "Login page: keep the language after a redirect" },
    ]);
    expect(server).toMatchObject({ duplicates: 0, refused: 0, shortened: 0, overflow: 0 });
    expect(entries(JIRA_CLOUD)).toEqual([
      { key: "PAY-482", title: "Checkout fails on expired card" },
      { key: "PAY-483", title: "Refund email shows the wrong currency" },
    ]);
  });

  it("reads a German Jira's column names", () => {
    expect(entries(JIRA_GERMAN)).toEqual([
      { key: "PAY-482", title: "Zahlung schlägt bei abgelaufener Karte fehl" },
    ]);
  });

  it("reads Azure DevOps' query results", () => {
    expect(entries(ADO_QUERY)).toEqual([
      { key: "1234", title: "Export the sprint as CSV" },
      { key: "1235", title: "Board drops the filter on reload" },
    ]);
  });

  it("reads a quoted cell with a line break and doubled quotes", () => {
    expect(entries(ADO_QUOTED)).toEqual([
      { key: "1234", title: 'Export the sprint as CSV, "quoted" too' },
      { key: "1235", title: "Board drops the filter" },
    ]);
  });

  it("finds its columns in any order", () => {
    expect(entries(ADO_BACKLOG)).toEqual([
      { key: "1234", title: "Export the sprint as CSV" },
      { key: "1235", title: "Board drops the filter on reload" },
    ]);
    const swapped = "Summary\tLink\tKey\nFix it\thttps://j.co/browse/AB-1\tAB-1";
    expect(entries(swapped)).toEqual([
      { key: "AB-1", title: "Fix it", url: "https://j.co/browse/AB-1" },
    ]);
  });
});

describe("tables without a known header", () => {
  it("reads a row by what its cells look like", () => {
    expect(entries("Story\tPAY-1\tFix the login\tAna")).toEqual([
      { key: "PAY-1", title: "Fix the login" },
    ]);
    expect(entries("1234\tFix the login\t3")).toEqual([{ key: "1234", title: "Fix the login" }]);
    expect(entries("https://j.co/browse/AB-1\tFix it")).toEqual([
      { key: "AB-1", title: "Fix it", url: "https://j.co/browse/AB-1" },
    ]);
    expect(entries("AB-1\tFix it\thttps://j.co/browse/AB-1")).toEqual([
      { key: "AB-1", title: "Fix it", url: "https://j.co/browse/AB-1" },
    ]);
  });

  it("does not take a points column for an id", () => {
    expect(entries("PAY-1\tFix it\t5")).toEqual([{ key: "PAY-1", title: "Fix it" }]);
    expect(entries("Story\t5\tFix it")).toEqual([{ title: "Fix it" }]);
  });

  it("skips a header it does not know when the rows under it hold keys", () => {
    expect(entries("Ticket\tName\nPAY-1\tFix it")).toEqual([{ key: "PAY-1", title: "Fix it" }]);
  });

  it("keeps a first row that holds a key: there is no header", () => {
    expect(entries("PAY-1\tFix it\nPAY-2\tAnd this")).toHaveLength(2);
  });

  it("reads plain lines among a table's rows as lines", () => {
    expect(entries("PAY-1\tFix it\nPAY-2 And this\n\nJust a title")).toEqual([
      { key: "PAY-1", title: "Fix it" },
      { key: "PAY-2", title: "And this" },
      { title: "Just a title" },
    ]);
  });

  it("counts a row under a known header with nothing to use as refused", () => {
    expect(parsePaste("Key\tSummary\tStatus\tOwner\n\t\tTo Do\tAna").refused).toBe(1);
  });

  it("takes the longest text after the key, not the type beside it", () => {
    expect(entries("1234\tUser Story\tExport the sprint as CSV\tNew")).toEqual([
      { key: "1234", title: "Export the sprint as CSV" },
    ]);
    expect(entries("1234\tUser Story\tExport it\tAna Lima <ana@example.com>\tNew")).toEqual([
      { key: "1234", title: "User Story" },
    ]);
  });

  it("falls back on a row's looks for each column its header does not name", () => {
    expect(entries("Vorgang\tZusammenfassung\nPAY-1\tFix it")).toEqual([
      { key: "PAY-1", title: "Fix it" },
    ]);
    expect(entries("Type\tWork item\tSummary\nStory\tPAY-2\tFix it")).toEqual([
      { key: "PAY-2", title: "Fix it" },
    ]);
    expect(entries("Key\tBeschreibung\nPAY-3\tFix it")).toEqual([
      { key: "PAY-3", title: "Fix it" },
    ]);
    expect(entries("Ticket\tZusammenfassung\nhttps://j.co/browse/PAY-4\tFix it")).toEqual([
      { key: "PAY-4", title: "Fix it", url: "https://j.co/browse/PAY-4" },
    ]);
  });

  it("finds a header under a line or two of the page", () => {
    expect(entries("My open tickets\n\nKey\tSummary\tStatus\nPAY-1\tFix it\tOpen")).toEqual([
      { key: "PAY-1", title: "Fix it" },
    ]);
    expect(entries("Showing 1-2\nTicket\tName\nPAY-1\tFix it")).toEqual([
      { key: "PAY-1", title: "Fix it" },
    ]);
  });

  it("takes no header from under a row that holds a key", () => {
    expect(entries("PAY-1\tFix\nKey\tSummary\nPAY-2\tThis")).toContainEqual({
      key: "PAY-2",
      title: "This",
    });
    expect(entries("PAY-1\tFix\nKey\tSummary\nPAY-2\tThis")).toHaveLength(3);
  });

  it("reads a lone link under a known header as a line", () => {
    expect(entries("Key\tSummary\nAB-1\tFix\nhttps://j.co/browse/AB-2")).toEqual([
      { key: "AB-1", title: "Fix" },
      { url: "https://j.co/browse/AB-2", key: "AB-2" },
    ]);
  });
});

describe("tableRows", () => {
  it("keeps a lone quote and a stray one as text", () => {
    expect(tableRows('"open\tb\nc"d\te')).toEqual([
      ['"open', "b"],
      ['c"d', "e"],
    ]);
    expect(tableRows('"unclosed')).toEqual([['"unclosed']]);
    expect(tableRows('"a"b\tc')).toEqual([['"a"b', "c"]]);
  });

  it("keeps a tab inside quotes and an empty cell at the end", () => {
    expect(tableRows('"a\tb"\tc\t')).toEqual([["a\tb", "c", ""]]);
  });
});

describe("one item per line", () => {
  it("reads keys in every form", () => {
    expect(entries("ABC-123\n#1234\nAB#5678")).toEqual([
      { key: "ABC-123" },
      { key: "1234" },
      { key: "5678" },
    ]);
  });

  it("reads a key followed by a title, whatever parts them", () => {
    expect(entries("ABC-1 Fix\nABC-2: Fix\nABC-3 - Fix\nABC-4 \u{2013} Fix\n#12 Fix")).toEqual([
      { key: "ABC-1", title: "Fix" },
      { key: "ABC-2", title: "Fix" },
      { key: "ABC-3", title: "Fix" },
      { key: "ABC-4", title: "Fix" },
      { key: "12", title: "Fix" },
    ]);
  });

  it("reads every kind of link subject.ts knows, cloud and server", () => {
    const links = [
      ["https://acme.atlassian.net/browse/ABC-1", "ABC-1"],
      ["https://jira.acme.com/jira/browse/ABC-2", "ABC-2"],
      ["https://acme.atlassian.net/jira/software/projects/ABC/issues/ABC-3", "ABC-3"],
      [
        "https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=1&selectedIssue=ABC-4",
        "ABC-4",
      ],
      ["https://dev.azure.com/acme/proj/_workitems/edit/12", "12"],
      ["https://acme.visualstudio.com/proj/_workitems/edit/13", "13"],
      ["https://tfs.acme.com/tfs/coll/proj/_workitems/edit/14", "14"],
      ["https://dev.azure.com/acme/proj/_boards/board?workitem=15", "15"],
    ] as const;
    for (const [url, key] of links) expect(entries(url), url).toEqual([{ url, key }]);
  });

  it("reads a link followed by a title, and a link with no key", () => {
    expect(entries("https://j.co/browse/AB-1 Fix the login")).toEqual([
      { url: "https://j.co/browse/AB-1", key: "AB-1", title: "Fix the login" },
    ]);
    expect(entries("https://example.com/page")).toEqual([{ url: "https://example.com/page" }]);
  });

  it("splits a line of nothing but keys or links, and counts each", () => {
    expect(entries("ABC-15, ABC-16")).toEqual([{ key: "ABC-15" }, { key: "ABC-16" }]);
    expect(entries("ABC-18 ABC-19;ABC-20")).toEqual([
      { key: "ABC-18" },
      { key: "ABC-19" },
      { key: "ABC-20" },
    ]);
    expect(entries("#12, AB#13")).toEqual([{ key: "12" }, { key: "13" }]);
    expect(entries("https://j.co/browse/AB-1, https://j.co/browse/AB-2")).toEqual([
      { url: "https://j.co/browse/AB-1", key: "AB-1" },
      { url: "https://j.co/browse/AB-2", key: "AB-2" },
    ]);
    expect(parsePaste("ABC-15, ABC-16, ABC-15").duplicates).toBe(1);
  });

  it("keeps a link's key under a comma at its end", () => {
    expect(entries("https://j.co/browse/AB-1,")).toEqual([
      { url: "https://j.co/browse/AB-1", key: "AB-1" },
    ]);
  });

  it("reads bullets, brackets and angle brackets", () => {
    expect(entries("- AB-1 Fix\n* AB-2\n\u{2022} AB-3: Fix\n1. AB-4\n- [ ] AB-5 Fix")).toEqual([
      { key: "AB-1", title: "Fix" },
      { key: "AB-2" },
      { key: "AB-3", title: "Fix" },
      { key: "AB-4" },
      { key: "AB-5", title: "Fix" },
    ]);
    expect(entries("- Fix the login")).toEqual([{ title: "Fix the login" }]);
    expect(entries("[AB-1] Fix\n[AB-2] fix it too\n[not a key] Fix")).toEqual([
      { key: "AB-1", title: "Fix" },
      { key: "AB-2", title: "fix it too" },
      { title: "[not a key] Fix" },
    ]);
    expect(entries("<https://j.co/browse/AB-3>\n<https://j.co/browse/AB-4> Fix")).toEqual([
      { url: "https://j.co/browse/AB-3", key: "AB-3" },
      { url: "https://j.co/browse/AB-4", key: "AB-4", title: "Fix" },
    ]);
  });

  it("reads a Jira service desk's queue link", () => {
    const url = "https://acme.atlassian.net/jira/servicedesk/projects/HELP/queues/custom/1/HELP-12";
    expect(entries(url)).toEqual([{ url, key: "HELP-12" }]);
  });

  it("takes a key before lower-case words for a sentence: nothing is dropped as a duplicate", () => {
    const result = parsePaste(
      "UTF-8 support\nUTF-8 bug\nISO-8601 dates\nISO-8601 parsing\nABC-123 Title",
    );
    expect(result.duplicates).toBe(0);
    expect(result.items).toEqual([
      { title: "UTF-8 support" },
      { title: "UTF-8 bug" },
      { title: "ISO-8601 dates" },
      { title: "ISO-8601 parsing" },
      { key: "ABC-123", title: "Title" },
    ]);
    expect(entries("ABC-1: fix it\nABC-2 - fix it\nABC-3")).toEqual([
      { key: "ABC-1", title: "fix it" },
      { key: "ABC-2", title: "fix it" },
      { key: "ABC-3" },
    ]);
  });

  it("makes a title of anything else: a person gets a queue, not an error", () => {
    expect(entries("Fix the login\nweb-2 migration\nA-1 is not a key")).toEqual([
      { title: "Fix the login" },
      { title: "web-2 migration" },
      { title: "A-1 is not a key" },
    ]);
  });

  it("never makes a link of another scheme, or of a link with a hidden host", () => {
    const lines = [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://example.com/x",
      "https://a.com@b.com/x",
    ];
    const items = entries(lines.join("\n"));
    expect(items.map((item) => item.url)).toEqual([undefined, undefined, undefined, undefined]);
    expect(items.map((item) => item.title)).toEqual(lines);
  });

  it("skips blank lines, and a byte order mark", () => {
    expect(entries("\u{FEFF}AB-1\r\n\r\n   \r\nAB-2\r")).toEqual([
      { key: "AB-1" },
      { key: "AB-2" },
    ]);
    expect(parsePaste("\n \n")).toEqual({
      items: [],
      sources: [],
      header: null,
      left: [],
      duplicates: 0,
      refused: 0,
      shortened: 0,
      overflow: 0,
    });
  });
});

describe("raw CSV", () => {
  it("is a table, with a known header or rows of keys", () => {
    expect(entries('Key,Summary,Status\nPAY-1,"Fix, then test",Open\nPAY-2,Ship it,Done')).toEqual([
      { key: "PAY-1", title: "Fix, then test" },
      { key: "PAY-2", title: "Ship it" },
    ]);
    expect(entries("Schlüssel;Zusammenfassung\nPAY-1;Beheben")).toEqual([
      { key: "PAY-1", title: "Beheben" },
    ]);
    expect(entries("PAY-1,Fix it,Open\nPAY-2,Ship it,Done")).toEqual([
      { key: "PAY-1", title: "Fix it" },
      { key: "PAY-2", title: "Ship it" },
    ]);
  });

  it("leaves titles with commas alone, and a number after one", () => {
    expect(entries("Fix the login, then test\nShip it, finally")).toEqual([
      { title: "Fix the login, then test" },
      { title: "Ship it, finally" },
    ]);
    expect(entries("Upgrade to v2, 3")).toEqual([{ title: "Upgrade to v2, 3" }]);
  });

  it("reads a key and words after a comma on a line of its own", () => {
    expect(entries("PAY-1, Fix it\nPAY-2")).toEqual([
      { key: "PAY-1", title: "Fix it" },
      { key: "PAY-2" },
    ]);
  });
});

describe("what the rules refuse", () => {
  it("counts a line with hidden or control characters, and keeps the rest", () => {
    const result = parsePaste("AB-1\nbidi \u{202E}override\nzero\u{200B}width\nbell\u{0007}\nAB-2");
    expect(result.items).toEqual([{ key: "AB-1" }, { key: "AB-2" }]);
    expect(result.refused).toBe(3);
  });

  it("cuts a long title with an ellipsis and says so", () => {
    const long = "x".repeat(MAX_TITLE_LENGTH + 40);
    const result = parsePaste(long);
    expect(result.shortened).toBe(1);
    expect(result.items[0]?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(result.items[0]?.title?.endsWith("\u{2026}")).toBe(true);
  });

  it("leaves room for a key without a link, which shares the title", () => {
    const result = parsePaste(`AB-1 ${"X".repeat(MAX_TITLE_LENGTH)}`);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toHaveLength(MAX_TITLE_LENGTH - "AB-1 ".length);
  });

  it("does not take from a title beside a link: the link holds the key", () => {
    const url = "https://j.co/browse/AB-1";
    const title = "x".repeat(MAX_TITLE_LENGTH);
    expect(entries(`${url} ${title}`)).toEqual([{ url, key: "AB-1", title }]);
  });

  it("refuses a link that is too long, as a title too", () => {
    const long = `https://example.com/${"x".repeat(MAX_LINK_LENGTH)}`;
    const result = parsePaste(long);
    expect(result.items[0]?.url).toBeUndefined();
    expect(result.shortened).toBe(1);
  });
});

describe("duplicates and the limit", () => {
  it("drops a duplicate within a paste, by key, link or title", () => {
    const result = parsePaste("AB-1\nAB-1 Same key\nFix\nfix\nhttps://e.co/a\nhttps://e.co/a");
    expect(result.items).toEqual([{ key: "AB-1" }, { title: "Fix" }, { url: "https://e.co/a" }]);
    expect(result.duplicates).toBe(3);
  });

  it("drops what the queue already holds", () => {
    const known = [queueIdentity({ key: "AB-1" }), queueIdentity({ title: "Fix" })];
    const result = parsePaste("AB-1\nFIX\nAB-2", { known });
    expect(result.items).toEqual([{ key: "AB-2" }]);
    expect(result.duplicates).toBe(2);
  });

  it("a link and its bare key are the same ticket", () => {
    expect(parsePaste("AB-1\nhttps://j.co/browse/AB-1").duplicates).toBe(1);
  });

  it("takes what fits and counts the rest", () => {
    const result = parsePaste("AB-1\nAB-2\nAB-3\nAB-1", { room: 2 });
    expect(result.items).toHaveLength(2);
    expect(result).toMatchObject({ overflow: 1, duplicates: 1 });
  });

  it("takes what fits the queue's bytes too", () => {
    const line = (n: number) => `T${n} ${"\u{754C}".repeat(150)}`;
    const text = Array.from({ length: 10 }, (_, n) => line(n)).join("\n");
    const room = MAX_QUEUE_BYTES - 5 * queueBytes([{ title: line(0), id: 1 }]);
    const result = parsePaste(text, { bytes: room });
    expect(result.items.length).toBeLessThan(10);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.overflow).toBe(10 - result.items.length);
    expect(queueBytes(result.items) + room).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
  });

  it("keeps the lines that did not go in, under a table's header", () => {
    const lines = parsePaste("AB-1\nbell\u{0007}\nAB-2\nAB-3", { room: 2 });
    expect(pasteLeft(lines)).toBe("bell\u{0007}\nAB-3");
    const table = parsePaste('Key\tSummary\nAB-1\tFix\nAB-2\t"One\ntwo"', { room: 1 });
    expect(pasteLeft(table)).toBe('Key\tSummary\nAB-2\t"One\ntwo"');
    expect(parsePaste(pasteLeft(table)).items).toEqual([{ key: "AB-2", title: "One two" }]);
    expect(pasteLeft(parsePaste("AB-1\nAB-1"))).toBe("");
  });

  it("keeps what a failed send left, in order", () => {
    const result = parsePaste("AB-1\nAB-2\nbell\u{0007}\nAB-3");
    expect(pasteLeft(result, 1)).toBe("AB-2\nAB-3\nbell\u{0007}");
  });
});

describe("speed", () => {
  const tsv = [
    "T\tKey\tSummary\tAssignee\tReporter\tP\tStatus",
    ...Array.from(
      { length: 200 },
      (_, n) =>
        `\tPAY-${n + 1}\tTicket number ${n + 1} with a title of a fair length, as they come\tAna Lima\tBen Roth\t\tTo Do`,
    ),
  ].join("\n");

  it("parses 200 items in far less than 100 ms", () => {
    const runs = Array.from({ length: 7 }, () => {
      const started = performance.now();
      const { items } = parsePaste(tsv);
      const took = performance.now() - started;
      expect(items).toHaveLength(200);
      return took;
    });
    // The median, so one garbage collection on a busy runner cannot fail it.
    const median = runs.sort((a, b) => a - b)[3] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThan(100);
  });

  it("stays linear on a long text of quotes", () => {
    const started = performance.now();
    parsePaste(`${'"a\t"b"\n'.repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("queueBatches", () => {
  const ordinary = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      key: `PAY-${n + 1}`,
      title: `Ticket number ${n + 1} with a title of a fair length, as most of them are`,
      url: `https://acme.atlassian.net/browse/PAY-${n + 1}`,
    }));
  const command = (items: unknown) =>
    new TextEncoder().encode(
      `42123${JSON.stringify(["cmd", { id: "x".repeat(64), type: "queueAdd", payload: { items } }])}`,
    ).length;

  it("takes two commands for 200 ordinary tickets and six for 500", () => {
    expect(queueBatches(ordinary(200))).toHaveLength(2);
    expect(queueBatches(ordinary(MAX_QUEUE_ITEMS))).toHaveLength(6);
    expect(queueBatches(ordinary(MAX_QUEUE_ITEMS)).flat()).toEqual(ordinary(MAX_QUEUE_ITEMS));
    for (const batch of queueBatches(ordinary(MAX_QUEUE_ITEMS))) {
      expect(command(batch)).toBeLessThan(MAX_MESSAGE_BYTES);
    }
    expect(queueBatches([])).toEqual([]);
  });

  it("is one command for a short list", () => {
    expect(queueBatches(ordinary(30))).toHaveLength(1);
  });

  it("fits the largest item the rules allow in a message", () => {
    const item = (key: string) => ({
      key,
      title: "\u{1F600}".repeat(MAX_TITLE_LENGTH),
      url: `https://e.co/${"\u{754C}".repeat(1980)}`,
    });
    const batches = queueBatches(["PAY-1", "PAY-2", "PAY-3"].map(item));
    expect(batches.flat()).toHaveLength(3);
    for (const batch of batches) expect(command(batch)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it("splits a list of very long links so each batch fits, keeping its order", () => {
    const items = Array.from({ length: 200 }, (_, n) => ({
      url: `https://example.com/${n}/${"x".repeat(MAX_LINK_LENGTH - 40)}`,
    }));
    const batches = queueBatches(items);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items);
    for (const batch of batches) {
      expect(command(batch)).toBeLessThan(MAX_MESSAGE_BYTES);
    }
  });
});
