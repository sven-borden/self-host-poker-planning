/**
 * A round's subject (#21): the link check and the issue key the server reads from it.
 * A title's text rules are `cleanText`'s, tested with names in `apply-input.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { cleanSubject, linkKey } from "./apply-subject.ts";

describe("linkKey", () => {
  it("reads a Jira key from /browse/, /projects/…/issues/ and selectedIssue=, on any host", () => {
    for (const [url, key] of [
      ["https://acme.atlassian.net/browse/ABC-123", "ABC-123"],
      ["https://acme.atlassian.net/browse/ABC-123/", "ABC-123"],
      ["https://acme.atlassian.net/browse/ABC-123?focusedCommentId=7#c7", "ABC-123"],
      ["http://jira.example.com/jira/browse/PAY_2-482", "PAY_2-482"],
      [
        "https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9",
        "ABC-9",
      ],
      [
        "https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=1&selectedIssue=XY-12&q=1",
        "XY-12",
      ],
      ["https://jira.example.com/browse/AB-1234567890", "AB-1234567890"],
      // Jira Cloud's issue view inside a project.
      ["https://acme.atlassian.net/jira/software/projects/PAY/issues/PAY-482", "PAY-482"],
      ["https://acme.atlassian.net/jira/core/projects/PAY/issues/PAY-482/?filter=all", "PAY-482"],
      ["https://acme.atlassian.net/projects/PAY/issues/PAY-482", "PAY-482"],
      // In any case, stored in capitals.
      ["https://acme.atlassian.net/browse/pay-482", "PAY-482"],
      ["https://acme.atlassian.net/BROWSE/Pay_2-7", "PAY_2-7"],
      ["https://acme.atlassian.net/jira/software/projects/pay/issues/pay-482", "PAY-482"],
      ["https://acme.atlassian.net/issues?SELECTEDISSUE=ab-1", "AB-1"],
    ] as const) {
      expect(linkKey(url), url).toBe(key);
    }
  });

  it("reads an Azure DevOps work item id from _workitems/edit/ on any host", () => {
    for (const [url, key] of [
      ["https://dev.azure.com/acme/Payments/_workitems/edit/12345", "12345"],
      ["https://dev.azure.com/acme/Pay%20ments/_workitems/edit/12345/", "12345"],
      ["https://DEV.AZURE.COM/acme/Payments/_WorkItems/Edit/7?src=x#y", "7"],
      ["https://acme.visualstudio.com/Payments/_workitems/edit/42", "42"],
      ["https://acme.visualstudio.com/DefaultCollection/Payments/_workitems/edit/42", "42"],
      // Azure DevOps Server, self-hosted: a collection and a project, or /tfs before them.
      ["https://devops.example.com/DefaultCollection/Payments/_workitems/edit/12345", "12345"],
      ["https://tfs.example.com:8080/tfs/DefaultCollection/Payments/_workitems/edit/9", "9"],
    ] as const) {
      expect(linkKey(url), url).toBe(key);
    }
  });

  it("reads workitem= on dev.azure.com and visualstudio.com", () => {
    for (const [url, key] of [
      ["https://dev.azure.com/acme/Payments/_boards/board/t/Team/Stories?workitem=12345", "12345"],
      ["https://dev.azure.com/acme/Payments/_backlogs/backlog?a=1&workitem=7&b=2", "7"],
      ["https://acme.visualstudio.com/Payments/_boards/board?WorkItem=42#x", "42"],
    ] as const) {
      expect(linkKey(url), url).toBe(key);
    }
  });

  it("finds nothing in near misses", () => {
    for (const url of [
      "https://example.com/",
      "https://acme.atlassian.net/browse/A-1",
      "https://acme.atlassian.net/browse/1AB-2",
      "https://acme.atlassian.net/browse/ABC-0",
      "https://acme.atlassian.net/browse/ABC-012",
      "https://acme.atlassian.net/browse/ABC-",
      "https://acme.atlassian.net/browse/ABC-123x",
      "https://acme.atlassian.net/browse/ABC-123/comments",
      "https://acme.atlassian.net/browsex/ABC-1",
      "https://acme.atlassian.net/browse/ABC-12345678901",
      `https://acme.atlassian.net/browse/A${"B".repeat(32)}-1`,
      "https://acme.atlassian.net/issues?notselectedIssue=ABC-1",
      "https://acme.atlassian.net/issues?selectedIssue=ABC-1x",
      "https://acme.atlassian.net/issues#selectedIssue=ABC-1",
      "https://acme.atlassian.net/x#/browse/ABC-1",
      // Jira Cloud's project paths without an issue, or with more after it.
      "https://acme.atlassian.net/jira/software/projects/PAY/issues",
      "https://acme.atlassian.net/jira/software/projects/PAY/issues/",
      "https://acme.atlassian.net/jira/software/projects/PAY/issues/PAY-482/edit",
      "https://acme.atlassian.net/jira/software/projects//issues/PAY-482",
      "https://acme.atlassian.net/jira/software/projects/PAY/issue/PAY-482",
      "https://acme.atlassian.net/jira/software/projects/PAY/boards/PAY-482",
      // Azure DevOps paths.
      "https://acme.visualstudio.com/_workitems/edit/42",
      "https://dev.azure.com/a/b/c/d/_workitems/edit/12345",
      "https://dev.azure.com/acme/Payments/_workitems/edit/",
      "https://dev.azure.com/acme/Payments/_workitems/edit/0",
      "https://dev.azure.com/acme/Payments/_workitems/edit/12a",
      "https://dev.azure.com/acme/Payments/_workitems/edit/12345678901",
      "https://dev.azure.com/acme/Payments/_workitems/edit/12345/history",
      "https://dev.azure.com/acme/Payments/_workitems/view/12345",
      "https://dev.azure.com/acme/Payments/_workitems?edit=12345",
      // workitem= only on Azure DevOps Services' own hosts, and only as a whole parameter.
      "https://evil.example/acme/Payments/_boards/board?workitem=12345",
      "https://dev.azure.com.evil.example/acme/Payments/_boards/board?workitem=12345",
      "https://acme.visualstudio.com.evil.example/Payments/_boards/board?workitem=42",
      "https://visualstudio.com/Payments/_boards/board?workitem=42",
      "https://dev.azure.com:8443/acme/Payments/_boards/board?workitem=1",
      "https://dev.azure.com/acme/Payments/_boards/board?myworkitem=1",
      "https://dev.azure.com/acme/Payments/_boards/board?workitem=0",
      "https://dev.azure.com/acme/Payments/_boards/board?workitem=12a",
      "https://dev.azure.com/acme/Payments/_boards/board#workitem=12",
      "ftp://acme.atlassian.net/browse/ABC-1",
    ]) {
      expect(linkKey(url), url).toBeNull();
    }
  });

  it("is set by cleanSubject on the link it accepts, and a client's own key is dropped", () => {
    expect(
      cleanSubject({ kind: "link", url: " https://acme.atlassian.net/browse/ABC-1 ", key: "X-1" }),
    ).toEqual({ kind: "link", url: "https://acme.atlassian.net/browse/ABC-1", key: "ABC-1" });
    expect(cleanSubject({ kind: "link", url: "https://example.com/a", key: "X-1" })).toEqual({
      kind: "link",
      url: "https://example.com/a",
    });
    // Refused before any key is read: credentials, another scheme.
    expect(
      cleanSubject({ kind: "link", url: "http://user:pass@x.example/browse/ABC-1" }),
    ).toBeNull();
    expect(cleanSubject({ kind: "link", url: "javascript:alert(1)//browse/ABC-1" })).toBeNull();
    expect(cleanSubject({ kind: "link", url: "data:text/html,/browse/ABC-1" })).toBeNull();
  });
});
