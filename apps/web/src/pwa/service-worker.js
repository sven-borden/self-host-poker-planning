// The service worker (#46, ADR-022), served as `/sw.js`. `scripts/pwa-plugin.ts` fills in
// the two constants below at build time, so every build that changes what is cached is a new
// worker, and `service-worker.test.ts` runs this very file against a stand-in browser.
//
// It keeps the page's files, never a room:
// - A navigation always goes to the network and its answer is never stored: not under its
//   URL, where a room's code would land (a bearer capability), and not as a shell, whose
//   tags the server fills per deployment and whose script names a deploy changes. Only with
//   no network does it answer, with the plain offline page, stored under its own name.
// - A file under `/assets/` has its content's hash in its name, so a stored copy cannot go
//   stale. It is stored under its path, without any query.
// - `/api` and `/socket.io` (a sign-in's redirect is a navigation there), other origins, and
//   anything but a GET are left to the browser: no `respondWith`, as if no worker ran.
//
// A new build takes over at once and drops the last one's files. It need not wait for tabs
// to close, since nothing here can hold an old app in place: the next navigation is the
// server's, and an open tab keeps running what it has loaded. It is not reloaded: an old tab
// is told to by the room's `protocol_mismatch`, when that matters. Nothing here logs.

const BUILD = "__PP_BUILD__";
const PRECACHE = ["__PP_PRECACHE__"];

const OFFLINE_PAGE = "/offline.html";
const PREFIX = "pp-shell-";
const CACHE = `${PREFIX}${BUILD}`;
const LEFT_ALONE = /^\/(api|socket\.io)(\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      const old = names.filter((name) => name.startsWith(PREFIX) && name !== CACHE);
      return Promise.all(old.map((name) => caches.delete(name)));
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (LEFT_ALONE.test(url.pathname)) return;
  if (request.mode === "navigate") event.respondWith(navigate(request));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request, url.pathname));
});

async function navigate(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match(OFFLINE_PAGE)) ?? Response.error();
  }
}

async function asset(request, path) {
  const cache = await caches.open(CACHE);
  const stored = await cache.match(path);
  if (stored) return stored;
  const response = await fetch(request);
  // Storage may be full: the page has its file all the same.
  if (response.ok && response.type === "basic") {
    cache.put(path, response.clone()).catch(() => {});
  }
  return response;
}
