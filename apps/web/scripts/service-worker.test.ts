import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { workerSource } from "./pwa-plugin.ts";

// The worker's very file, run against a stand-in for the browser: its events, Cache Storage
// and the network. e2e/pwa.spec.ts holds it in a real one.

const template = readFileSync(join(import.meta.dirname, "../src/pwa/service-worker.js"), "utf8");
const ORIGIN = "https://poker.example.com";
const CODE = "4mZk8pQr2T";
const OFFLINE = "offline page";

class FakeCache {
  entries = new Map<string, Response>();
  key = (request: string) => new URL(request, ORIGIN).href;
  match = async (request: string) => this.entries.get(this.key(request))?.clone();
  put = async (request: string, response: Response) => {
    this.entries.set(this.key(request), response);
  };
  addAll = async (requests: string[]) => {
    for (const request of requests) this.entries.set(this.key(request), new Response(OFFLINE));
  };
}

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  request?: FakeRequest;
  respondWith: (answer: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

function startWorker(build = "one") {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => stores.get(name) ?? stores.set(name, new FakeCache()).get(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetch = vi.fn<(request: FakeRequest) => Promise<Response>>();
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  new Function("self", "caches", "fetch", workerSource(template, build, ["/offline.html"]))(
    self,
    caches,
    fetch,
  );

  /** Fires an event: what it answered, once the work it asked to wait for is done. */
  async function fire(type: string, request?: FakeRequest) {
    let answer: Promise<Response> | undefined;
    const work: Promise<unknown>[] = [];
    listeners.get(type)?.({
      request,
      respondWith: (response) => {
        answer = response;
      },
      waitUntil: (promise) => work.push(promise),
    });
    await Promise.all(work);
    return answer;
  }

  const request = (path: string, mode = "cors", method = "GET", origin = ORIGIN) => ({
    url: `${origin}${path}`,
    method,
    mode,
  });
  return { caches, stores, fetch, self, fire, request };
}

const asset = "/assets/index-C0ffee12.js";
const answer = (body: string, status = 200) => {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: "basic" });
  Object.defineProperty(response, "clone", { value: () => answer(body, status) });
  return response;
};

async function installed(build?: string) {
  const worker = startWorker(build);
  await worker.fire("install");
  await worker.fire("activate");
  return worker;
}

const keysOf = async (worker: Awaited<ReturnType<typeof installed>>) =>
  [...worker.stores.values()].flatMap((store) => [...store.entries.keys()]);

describe("install and activate", () => {
  it("stores the offline page under this build's name and takes over at once", async () => {
    const worker = await installed("one");
    expect(await worker.caches.keys()).toEqual(["pp-shell-one"]);
    expect(await keysOf(worker)).toEqual([`${ORIGIN}/offline.html`]);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("leaves nothing behind when the offline page cannot be stored", async () => {
    const worker = startWorker();
    const failing = await worker.caches.open("pp-shell-one");
    if (failing) failing.addAll = () => Promise.reject(new Error("offline"));
    await expect(worker.fire("install")).rejects.toThrow("offline");
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("drops every older build, and nothing that is not its own", async () => {
    const worker = startWorker("two");
    await worker.caches.open("pp-shell-one");
    await worker.caches.open("someone-elses");
    await worker.fire("install");
    await worker.fire("activate");
    expect((await worker.caches.keys()).sort()).toEqual(["pp-shell-two", "someone-elses"]);
  });
});

describe("what it leaves to the browser", () => {
  const untouched: [string, FakeRequest][] = [
    ["the API", { url: `${ORIGIN}/api/rooms/${CODE}`, method: "GET", mode: "cors" }],
    ["a sign-in's redirect", { url: `${ORIGIN}/api/auth/x`, method: "GET", mode: "navigate" }],
    ["the bare API path", { url: `${ORIGIN}/api`, method: "GET", mode: "navigate" }],
    ["the socket", { url: `${ORIGIN}/socket.io/?EIO=4`, method: "GET", mode: "cors" }],
    ["a POST", { url: `${ORIGIN}${asset}`, method: "POST", mode: "cors" }],
    ["a POST navigation", { url: `${ORIGIN}/`, method: "POST", mode: "navigate" }],
    ["another origin", { url: "https://cdn.example.com/assets/x.js", method: "GET", mode: "cors" }],
    ["a static file", { url: `${ORIGIN}/manifest.webmanifest`, method: "GET", mode: "cors" }],
  ];

  it.each(untouched)("%s", async (_name, request) => {
    const worker = await installed();
    expect(await worker.fire("fetch", request)).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});

describe("a navigation", () => {
  it("goes to the network and stores nothing, for a room least of all", async () => {
    const worker = await installed();
    const before = await keysOf(worker);
    worker.fetch.mockResolvedValue(answer("the app"));
    const response = await worker.fire("fetch", worker.request(`/r/${CODE}`, "navigate"));
    expect(await response?.text()).toBe("the app");
    expect(await keysOf(worker)).toEqual(before);
  });

  it("hands on the server's error, which is not the same as being offline", async () => {
    const worker = await installed();
    worker.fetch.mockResolvedValue(answer("bad gateway", 502));
    const response = await worker.fire("fetch", worker.request("/", "navigate"));
    expect(response?.status).toBe(502);
  });

  it("gets the offline page with no network, under no name of its own", async () => {
    const worker = await installed();
    worker.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const response = await worker.fire("fetch", worker.request(`/r/${CODE}`, "navigate"));
    expect(await response?.text()).toBe(OFFLINE);
    expect(JSON.stringify(await keysOf(worker))).not.toContain(CODE);
  });

  it("fails as the browser would when even that page is gone", async () => {
    const worker = await installed();
    worker.stores.get("pp-shell-one")?.entries.clear();
    worker.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const response = await worker.fire("fetch", worker.request("/", "navigate"));
    expect(response?.type).toBe("error");
  });
});

describe("a hashed asset", () => {
  it("is fetched once, then comes from the store, under its path alone", async () => {
    const worker = await installed();
    worker.fetch.mockResolvedValue(answer("code"));
    const request = worker.request(`${asset}?from=${CODE}`);
    expect(await (await worker.fire("fetch", request))?.text()).toBe("code");
    await vi.waitFor(async () => expect(await keysOf(worker)).toContain(`${ORIGIN}${asset}`));
    expect(await (await worker.fire("fetch", worker.request(asset)))?.text()).toBe("code");
    expect(worker.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(await keysOf(worker))).not.toContain(CODE);
  });

  it("is not stored when the server has no such file", async () => {
    const worker = await installed();
    worker.fetch.mockResolvedValue(answer("", 404));
    const response = await worker.fire("fetch", worker.request("/assets/gone-0ld0ld00.js"));
    expect(response?.status).toBe(404);
    expect(await keysOf(worker)).toEqual([`${ORIGIN}/offline.html`]);
  });

  it("still reaches the page when storage is full", async () => {
    const worker = await installed();
    const store = worker.stores.get("pp-shell-one");
    if (store) store.put = () => Promise.reject(new Error("quota"));
    worker.fetch.mockResolvedValue(answer("code"));
    expect(await (await worker.fire("fetch", worker.request(asset)))?.text()).toBe("code");
  });
});

it("writes nothing to the console: a URL there could hold a room's code", () => {
  expect(template).not.toMatch(/console\./);
});
