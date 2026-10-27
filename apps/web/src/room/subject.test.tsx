import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixedT, loadLanguage } from "../i18n/i18n.ts";
import { RoundSubject } from "./round-subject.tsx";
import {
  draftSubject,
  keyLabel,
  problemMessage,
  safeHref,
  shortUrl,
  subjectName,
} from "./subject.ts";

// A round's subject in the browser (#21): the PO's draft checked with the domain's rules
// before `startRound`, and the subject shown to everyone, a link only when it is http(s)
// without credentials (AC 1).

beforeAll(async () => {
  await Promise.all([loadLanguage("fr"), loadLanguage("de")]);
});
afterEach(cleanup);

describe("draftSubject", () => {
  it("turns an empty field into no subject, text into a title and a link into a link", () => {
    expect(draftSubject("")).toEqual({ ok: true, subject: { kind: "none" } });
    expect(draftSubject("  \t ")).toEqual({ ok: true, subject: { kind: "none" } });
    expect(draftSubject("  Split   invoices\tby currency ")).toEqual({
      ok: true,
      subject: { kind: "title", text: "Split invoices by currency" },
    });
    // A title may hold a colon or a scheme-looking word without becoming a link.
    expect(draftSubject("Fix: mailto links")).toEqual({
      ok: true,
      subject: { kind: "title", text: "Fix: mailto links" },
    });
    // A link is sent without a key: the server reads it.
    expect(draftSubject(" https://acme.atlassian.net/browse/PAY-482 ")).toEqual({
      ok: true,
      subject: { kind: "link", url: "https://acme.atlassian.net/browse/PAY-482" },
    });
    // A scheme-like word with a space after its colon is a title, not a refused link.
    for (const title of [
      "File: upload size limit",
      "Data: nightly export",
      "Blob: storage cleanup",
      "JavaScript: drop the old bundle",
    ]) {
      expect(draftSubject(title), title).toEqual({
        ok: true,
        subject: { kind: "title", text: title },
      });
    }
    expect(draftSubject("vbscript:\tlegacy macros")).toEqual({
      ok: true,
      subject: { kind: "title", text: "vbscript: legacy macros" },
    });
    expect(draftSubject("https://dev.azure.com/acme/Payments/_workitems/edit/12345")).toEqual({
      ok: true,
      subject: { kind: "link", url: "https://dev.azure.com/acme/Payments/_workitems/edit/12345" },
    });
    expect(draftSubject("HTTP://example.com")).toEqual({
      ok: true,
      subject: { kind: "link", url: "HTTP://example.com" },
    });
  });

  it("refuses a title over 200 characters and a link over 2,000, without cutting (AC 3)", () => {
    expect(draftSubject("é".repeat(200))).toMatchObject({ ok: true });
    expect(draftSubject("é".repeat(201))).toEqual({ ok: false, problem: "titleTooLong" });
    // Two hundred user-perceived characters, each of several code points, still fit.
    expect(draftSubject("👩\u{200D}💻".repeat(200))).toMatchObject({ ok: true });
    expect(draftSubject(`https://example.com/${"a".repeat(1980)}`)).toMatchObject({ ok: true });
    expect(draftSubject(`https://example.com/${"a".repeat(1981)}`)).toEqual({
      ok: false,
      problem: "linkTooLong",
    });
  });

  it("refuses other schemes and links with credentials (AC 1)", () => {
    for (const draft of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "File:upload",
      "data:,x",
      "blob:https://example.com/0a1b",
      "mailto://someone@example.com",
      "ftp://example.com/x",
      "http://user:pass@example.com/",
      "https://good.example@evil.example/",
      "https://exa mple.com",
    ]) {
      expect(draftSubject(draft), draft).toEqual({ ok: false, problem: "badLink" });
    }
  });

  it("refuses a title the domain refuses for another reason with bad_subject", () => {
    expect(draftSubject("Login\u{200B} page")).toEqual({ ok: false, problem: "bad_subject" });
    expect(draftSubject("x\u{300}\u{301}\u{302}\u{303}")).toEqual({
      ok: false,
      problem: "bad_subject",
    });
  });
});

describe("the subject's words", () => {
  const t = fixedT("en");

  it("says why a draft was refused", () => {
    expect(problemMessage(t, "titleTooLong")).toBe("A title can have at most 200 characters.");
    expect(problemMessage(t, "linkTooLong")).toBe("A link can have at most 2,000 characters.");
    expect(problemMessage(t, "badLink")).toBe(
      "Only http and https links work, without a user name or password.",
    );
    expect(problemMessage(t, "bad_subject")).toBe(t("errors.bad_subject"));
    expect(problemMessage(fixedT("fr"), "linkTooLong")).toBe(
      "Un lien ne peut pas dépasser 2\u{202F}000 caractères.",
    );
    expect(problemMessage(fixedT("de"), "titleTooLong")).toBe(
      "Ein Titel darf höchstens 200 Zeichen lang sein.",
    );
    expect(problemMessage(fixedT("de"), "badLink")).toBe(
      "Nur http- und https-Links sind möglich, ohne Benutzername und Passwort.",
    );
  });

  it("names a round by its key, its title or its number", () => {
    expect(subjectName(t, { number: 3, subject: { kind: "none" } })).toBe("Round 3");
    expect(subjectName(t, { number: 3, subject: { kind: "title", text: "Login" } })).toBe("Login");
    // The sentence ends with its own full stop: a title's own is left out.
    for (const [text, said] of [
      ["Why is login slow?", "Why is login slow"],
      ["Ship it!", "Ship it"],
      ["Export the invoices.", "Export the invoices"],
      ["And then\u{2026}", "And then"],
      ["Wait ?!", "Wait"],
      ["v1.2 or 3.0", "v1.2 or 3.0"],
      ["?", "?"],
    ] as const) {
      expect(subjectName(t, { number: 3, subject: { kind: "title", text } }), text).toBe(said);
    }
    const jira = { kind: "link", url: "https://x.example/browse/AB-1", key: "AB-1" } as const;
    expect(subjectName(t, { number: 3, subject: jira })).toBe("AB-1");
    const ado = { kind: "link", url: "https://dev.azure.com/a/b/_workitems/edit/7", key: "7" };
    expect(subjectName(t, { number: 3, subject: ado as typeof jira })).toBe("#7");
    expect(subjectName(t, { number: 3, subject: { kind: "link", url: "https://x.example" } })).toBe(
      "Round 3",
    );
    expect(subjectName(fixedT("de"), { number: 1234, subject: { kind: "none" } })).toBe(
      "Runde 1.234",
    );
  });

  it("shows a key as its chip and a link without one shortened", () => {
    expect(keyLabel("PAY-482")).toBe("PAY-482");
    expect(keyLabel("12345")).toBe("#12345");
    expect(shortUrl("https://www.example.com/")).toBe("example.com");
    expect(shortUrl("http://example.com/specs/42?tab=2#top")).toBe("example.com/specs/42");
    expect(shortUrl(`https://example.com/${"a".repeat(60)}`)).toBe(
      `example.com/${"a".repeat(27)}\u{2026}`,
    );
    expect(shortUrl(`https://example.com/${"a".repeat(60)}`)).toHaveLength(40);
  });

  it("lets only an http(s) link without credentials become a link", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://user:pass@example.com/",
      "//evil.example",
    ]) {
      expect(safeHref(url), url).toBeNull();
    }
  });
});

describe("RoundSubject", () => {
  const subjectLine = () => document.querySelector("[data-round-subject]");

  it("shows Round N alone without a subject", () => {
    render(<RoundSubject round={{ number: 3, anonymous: false, subject: { kind: "none" } }} />);
    expect(subjectLine()?.textContent).toBe("Round 3");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a title inside <bdi>, as text", () => {
    const text = "<b>Login</b> \u{5E9}\u{5DC}\u{5D5}\u{5DD}";
    render(
      <RoundSubject round={{ number: 2, anonymous: false, subject: { kind: "title", text } }} />,
    );
    const title = document.querySelector("bdi[data-subject-title]");
    expect(title?.textContent).toBe(text);
    expect(title?.querySelector("b")).toBeNull();
    // At most two lines on screen; the whole title on hover.
    expect(title?.getAttribute("title")).toBe(text);
    expect(title?.className).toContain("line-clamp-2");
  });

  it("renders a link with its key's chip, in a new tab, with rel noopener noreferrer (AC 1)", () => {
    const url = "https://acme.atlassian.net/browse/PAY-482";
    render(
      <RoundSubject
        round={{ number: 4, anonymous: false, subject: { kind: "link", url, key: "PAY-482" } }}
      />,
    );
    const link = screen.getByRole("link", { name: "PAY-482 (opens in a new tab)" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe(url);
    cleanup();
    const ado = "https://dev.azure.com/acme/Pay/_workitems/edit/12345";
    render(
      <RoundSubject
        round={{ number: 4, anonymous: false, subject: { kind: "link", url: ado, key: "12345" } }}
      />,
    );
    expect(screen.getByRole("link", { name: "#12345 (opens in a new tab)" })).toBeTruthy();
  });

  it("shows a link without a key shortened", () => {
    const url = "https://www.example.com/specs/42?tab=2";
    render(
      <RoundSubject round={{ number: 5, anonymous: false, subject: { kind: "link", url } }} />,
    );
    const link = screen.getByRole("link", { name: "example.com/specs/42 (opens in a new tab)" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never renders javascript:, data: or a link with credentials as a link (AC 1)", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://user:pass@example.com/browse/PAY-1",
    ]) {
      render(
        <RoundSubject
          round={{ number: 6, anonymous: false, subject: { kind: "link", url, key: "PAY-1" } }}
        />,
      );
      expect(screen.queryByRole("link"), url).toBeNull();
      expect(document.querySelector("[href]"), url).toBeNull();
      cleanup();
    }
  });
  it("marks an anonymous round after its number, with its hint (#25)", () => {
    const subject = { kind: "title", text: "Login" } as const;
    render(<RoundSubject round={{ number: 4, anonymous: true, subject }} />);
    const line = subjectLine();
    const chip = line?.querySelector("[data-round-anonymous]");
    expect(line?.firstElementChild?.textContent).toBe("Round 4");
    expect(line?.children[1]).toBe(chip);
    expect(chip?.querySelector("[title]")?.getAttribute("title")).toBe(
      "Cards are shown without names.",
    );
    expect(chip?.querySelector(".sr-only")?.textContent).toBe(
      "Anonymous round: cards are shown without names.",
    );
    cleanup();
    render(<RoundSubject round={{ number: 4, anonymous: false, subject }} />);
    expect(subjectLine()?.querySelector("[data-round-anonymous]")).toBeNull();
  });
});
