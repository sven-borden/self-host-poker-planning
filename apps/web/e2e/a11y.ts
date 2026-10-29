import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Shared by the accessibility specs (#37): axe over a page in both themes and two
// viewports, and the settle step every scan and snapshot waits for.

/** WCAG 2.2 A and AA, as axe tags them (2.0, 2.1 and 2.2 each have their own tag). */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** A desktop and one phone. */
export const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** Waits until no animation runs (a flip, a slide-in, a fade), so axe reads the end state. */
export async function settle(page: Page) {
  await page.waitForTimeout(100);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            // A running timer ring or pulse never ends: it does not count.
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
              ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(0);
}

export interface Finding {
  /** The screen, as `audit` was told. */
  where: string;
  /** Theme and viewport. */
  variant: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
  /** axe's reason, for the first node. */
  summary: string;
}

/** Every finding of the run, for the report at the end of the spec. */
export const findings: Finding[] = [];

/**
 * Runs axe on `page` as it is now, in light and dark and at each viewport, and fails on a
 * serious or critical violation. Moderate and minor ones, and what axe could not decide
 * ("review"), are collected in `findings`.
 */
export async function audit(page: Page, label: string) {
  const before = page.viewportSize();
  try {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await settle(page);
        const variant = `${scheme} ${viewport.name}`;
        const where = `${label}, ${variant}`;
        // No rule is switched off and nothing is excluded: a page that needs an exclusion
        // gets it here, by selector, with its reason on the line above.
        const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        // A scan that ran no rule would pass anything.
        expect(result.passes.length, where).toBeGreaterThan(10);
        // What axe could not decide (text over the felt's gradient, mostly) is reported as
        // "review": contrast.test.ts measures those pairs from the tokens.
        const undecided = result.incomplete.map((check) => ({ ...check, impact: "review" }));
        const found = [...result.violations, ...undecided].map((violation) => ({
          where: label,
          variant,
          id: violation.id,
          impact: violation.impact ?? "unknown",
          help: violation.help,
          targets: violation.nodes.map((node) => node.target.join(" ")).slice(0, 6),
          summary: (violation.nodes[0]?.failureSummary ?? "").replaceAll("\n", " "),
        }));
        findings.push(...found);
        const blocking = found.filter((f) => f.impact === "serious" || f.impact === "critical");
        expect.soft(blocking, `${where}: ${JSON.stringify(blocking, null, 2)}`).toEqual([]);
      }
    }
  } finally {
    await page.emulateMedia({ colorScheme: "light" });
    if (before) await page.setViewportSize(before);
  }
}

/**
 * Prints this test's findings below serious and attaches them to its report, one line
 * per rule and screen with the themes and viewports it was seen in.
 */
export function reportFindings() {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures from a destructuring pattern.
  test.afterEach(async ({}, info) => {
    const mine = findings.splice(0);
    if (mine.length === 0) return;
    const lines = new Map<string, { finding: Finding; variants: string[] }>();
    for (const finding of mine) {
      const key = `${finding.impact} ${finding.id} (${finding.where})`;
      const line = lines.get(key) ?? { finding, variants: [] };
      line.variants.push(finding.variant);
      lines.set(key, line);
    }
    const text = [...lines]
      .map(
        ([key, { finding, variants }]) =>
          `${key} [${variants.join(", ")}]: ${finding.help} → ${finding.targets.slice(0, 3).join(", ")}; ${finding.summary.slice(0, 160)}`,
      )
      .join("\n");
    console.log(`axe, ${info.title}:\n${text}`);
    await info.attach("axe-findings.txt", { body: text, contentType: "text/plain" });
  });
}

/** One thing a live region said: which region, and its words. */
export interface Said {
  region: string;
  text: string;
}

/**
 * Records, from the next page load on, what every live region of the page says (`status`,
 * `alert`, `log`, or `aria-live` polite or assertive), in order: what a screen reader
 * would announce, short of the reader itself. Read it with `transcript`.
 */
export async function listen(page: Page) {
  await page.addInitScript(() => {
    const said: { region: string; text: string }[] = [];
    Object.assign(window, { __said: said });
    const LIVE =
      "[role='status'], [role='alert'], [role='log'], [aria-live='polite'], [aria-live='assertive']";
    const last = new WeakMap<Element, string>();
    const name = (region: Element) =>
      [...region.attributes]
        .map((attribute) => attribute.name)
        .find((attribute) => attribute.startsWith("data-")) ??
      region.getAttribute("role") ??
      "live";
    // The same words again count when they come in a new element (the table's region
    // renders one per announcement), not when React only re-renders them.
    const hear = (region: Element, fresh: boolean) => {
      const text = (region.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text === "" || (!fresh && last.get(region) === text)) return;
      last.set(region, text);
      said.push({ region: name(region), text });
    };
    new MutationObserver((mutations) => {
      const regions = new Map<Element, boolean>();
      for (const mutation of mutations) {
        const node =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        const region = node?.closest(LIVE);
        const fresh = [...mutation.addedNodes].some((added) => added instanceof Element);
        if (region) regions.set(region, (regions.get(region) ?? false) || fresh);
        for (const added of mutation.addedNodes) {
          if (added instanceof Element && added.matches(LIVE)) regions.set(added, false);
        }
      }
      for (const [region, fresh] of regions) hear(region, fresh);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/** What the page's live regions said so far (`listen`), from `from` on. */
export async function transcript(page: Page, from = 0): Promise<Said[]> {
  const said = await page.evaluate(() => (window as unknown as { __said: Said[] }).__said);
  return said.slice(from);
}
