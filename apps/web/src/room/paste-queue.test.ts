import { MAX_LINK_LENGTH, MAX_QUEUE_ITEMS, MAX_TITLE_LENGTH, queueIdentity } from "@pp/domain";
import { WIRE_LIMITS } from "@pp/protocol";
import { describe, expect, it } from "vitest";
import { parsePaste, queueBatches, tableRows } from "./paste-queue.ts";

// The samples below are RECONSTRUCTED from each product's documented columns and copy
// behaviour, not copied from a live board (nobody here has a Jira). Tabs and line breaks
// are written out so that an editor cannot change them.
//
// - JIRA_SERVER: the issue navigator's list view (Jira Data Center's documented default
//   columns T, Key, Summary, Assignee, Reporter, P, Status, Resolution, Created, Updated),
//   selected in a browser and copied: the type and priority columns are icons, so their
//   cells paste empty. Support article "Searching for issues", column configuration.
// - JIRA_CLOUD: Jira Cloud's list view, columns Type, Key, Summary, Status, Assignee.
// - JIRA_GERMAN: JIRA_SERVER's list in a German Jira: the same columns under other names.
// - ADO_QUERY: Azure Boards' query results, "Copy to clipboard", documented in "Copy or
//   clone work items": a header row, tabs, the default columns ID, Work Item Type, Title,
//   Assigned To, State, Tags.
// - ADO_QUOTED: the same with a title of two lines: a cell with a line break comes in
//   quotes, as spreadsheets and browsers write it (RFC 4180's rule, with tabs).
// - ADO_BACKLOG: Azure Boards' backlog copy, with the order and points columns first.
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

describe("real list samples", () => {
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
    expect(parsePaste("Key\tSummary\tStatus\n\t\tTo Do").refused).toBe(1);
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
      duplicates: 0,
      refused: 0,
      shortened: 0,
      overflow: 0,
    });
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
    const result = parsePaste(`AB-1 ${"x".repeat(MAX_TITLE_LENGTH)}`);
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
  it("is one batch for a list that fits a socket message, even a full queue", () => {
    const items = Array.from({ length: MAX_QUEUE_ITEMS }, (_, n) => ({
      key: `PAY-${n + 1}`,
      title: "A ticket title of a fair length, about as long as most of them are",
      url: `https://acme.atlassian.net/browse/PAY-${n + 1}`,
    }));
    expect(queueBatches(items)).toHaveLength(1);
    expect(queueBatches([])).toEqual([]);
  });

  it("splits a list of very long links so each batch fits, keeping its order", () => {
    const items = Array.from({ length: 200 }, (_, n) => ({
      url: `https://example.com/${n}/${"x".repeat(MAX_LINK_LENGTH - 40)}`,
    }));
    const batches = queueBatches(items);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(
        WIRE_LIMITS.messageBytes,
      );
    }
  });
});
