import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register.ts";

const container = (register = vi.fn(async () => undefined)) =>
  ({ register }) as unknown as ServiceWorkerContainer;

describe("registerServiceWorker", () => {
  beforeEach(() => {
    vi.stubEnv("PROD", true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers the root's worker, past any cache, on a page that has loaded", () => {
    const workers = container();
    registerServiceWorker(workers);
    expect(workers.register).toHaveBeenCalledExactlyOnceWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("waits for a page that is still loading", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    const workers = container();
    registerServiceWorker(workers);
    expect(workers.register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("load"));
    window.dispatchEvent(new Event("load"));
    expect(workers.register).toHaveBeenCalledOnce();
  });

  it("does nothing in development", () => {
    vi.stubEnv("PROD", false);
    const workers = container();
    registerServiceWorker(workers);
    expect(workers.register).not.toHaveBeenCalled();
  });

  it("does nothing where the browser has no workers, and shrugs at a refusal", async () => {
    expect(() => registerServiceWorker(undefined)).not.toThrow();
    const refuse = vi.fn(() => Promise.reject(new Error("refused")));
    registerServiceWorker(container(refuse as never));
    await expect(refuse.mock.results[0]?.value).rejects.toThrow("refused");
  });
});
