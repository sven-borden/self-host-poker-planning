import { afterEach, describe, expect, it, vi } from "vitest";

const startSentry = vi.fn();
vi.mock("./sentry.ts", () => ({ startSentry }));

afterEach(() => {
  document.head.innerHTML = "";
  startSentry.mockReset();
  vi.resetModules();
});

/** A fresh copy of the module: it keeps its state for the page's lifetime. */
const load = () => import("./errors.ts");

describe("error reports (#40)", () => {
  it("load nothing and report nothing without a DSN in the page", async () => {
    const { reportError, startErrorReports } = await load();
    startErrorReports();
    reportError(new Error("boom"));
    await vi.dynamicImportSettled();
    expect(startSentry).not.toHaveBeenCalled();
  });

  it("start Sentry with the page's DSN and release, then report what waited", async () => {
    const reported: unknown[] = [];
    startSentry.mockReturnValue((error: unknown) => reported.push(error));
    document.head.innerHTML =
      '<meta name="pp-sentry-dsn" content="https://0123abcd@o1.ingest.sentry.io/42" data-release="0a14f15">';
    const { reportError, startErrorReports } = await load();
    startErrorReports();
    const early = new Error("before the chunk");
    reportError(early);
    await vi.dynamicImportSettled();
    expect(startSentry).toHaveBeenCalledWith({
      dsn: "https://0123abcd@o1.ingest.sentry.io/42",
      release: "0a14f15",
    });
    const late = new Error("after");
    reportError(late);
    expect(reported).toEqual([early, late]);
  });
});
