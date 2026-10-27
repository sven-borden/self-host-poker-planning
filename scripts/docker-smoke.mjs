// Smoke test of a running container, used by scripts/docker-check.sh (locally and in CI).
// No dependencies: Node 24's fetch and WebSocket speak to the server, and the Socket.IO
// handshake is written by hand (Engine.IO 4 over a WebSocket).
//
// Usage: node scripts/docker-smoke.mjs <base url> [expected commit]
// Checks: /api/health answers ok with db ok (and the expected commit); / serves the web
// app; a WebSocket with the right Origin connects and `enter` gets an ack; a foreign
// Origin is refused. When /api/auth exists (#10) it signs in anonymously first and sends
// the session cookie with the WebSocket.

const [baseArg, expectedCommit] = process.argv.slice(2);
if (!baseArg) {
  console.error("usage: node scripts/docker-smoke.mjs <base url> [expected commit]");
  process.exit(2);
}
const base = new URL(baseArg).origin;
const TIMEOUT_MS = 10_000;

/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
}

async function health() {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = /** @type {{ status?: unknown; db?: unknown; commit?: unknown }} */ (
    await res.json()
  );
  console.log(`health: ${JSON.stringify(body)}`);
  check(res.status === 200 && body.status === "ok", "/api/health answers 200 ok");
  check(body.db === "ok", "/api/health reports db ok");
  if (expectedCommit) check(body.commit === expectedCommit, `commit is ${expectedCommit}`);
}

async function webApp() {
  const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  check(
    res.status === 200 && text.includes('<div id="root">'),
    "/ serves the web app's index.html",
  );
}

/**
 * Signs in anonymously when Better Auth is mounted (#10) and returns the cookie header to
 * send with the WebSocket; undefined while /api/auth does not exist.
 * @returns {Promise<string | undefined>}
 */
async function anonymousSession() {
  const res = await fetch(`${base}/api/auth/sign-in/anonymous`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) {
    console.log("skip: no /api/auth yet, the socket connects without a session");
    return undefined;
  }
  check(res.ok, `anonymous sign-in answers 2xx (got ${res.status})`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  check(cookies.length > 0, "anonymous sign-in sets a session cookie");
  return cookies.join("; ");
}

/**
 * Opens a Socket.IO connection over a WebSocket and resolves with the ack of `enter`.
 * Rejects when the server refuses the upgrade or does not answer in time.
 * @param {string} origin
 * @param {string | undefined} cookie
 * @returns {Promise<unknown>}
 */
function enterOverWebSocket(origin, cookie) {
  const url = `${base.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
  /** @type {Record<string, string>} */
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no ack within 10 s"));
    }, TIMEOUT_MS);
    /** @param {() => void} settle */
    const finish = (settle) => {
      clearTimeout(timer);
      ws.close();
      settle();
    };
    ws.onerror = () => finish(() => reject(new Error("websocket refused or failed")));
    ws.onclose = (event) =>
      finish(() => reject(new Error(`websocket closed (${event.code}) before the ack`)));
    // Engine.IO open (0) → connect to namespace "/" (40); ping (2) → pong (3); namespace
    // connected (40) → emit `enter` with ack id 0 (420[...]); its ack is 430[...]; a
    // refused namespace connection (a middleware said no) is 44.
    ws.onmessage = (event) => {
      const data = String(event.data);
      if (data.startsWith("0")) {
        ws.send("40");
      } else if (data === "2") {
        ws.send("3");
      } else if (data.startsWith("40")) {
        ws.send('420["enter",{"code":"smoke","protocol":1}]');
      } else if (data.startsWith("44")) {
        finish(() => reject(new Error(`refused: ${data}`)));
      } else if (data.startsWith("430")) {
        const [ack] = JSON.parse(data.slice(3));
        ws.onclose = null;
        finish(() => resolve(ack));
      }
    };
  });
}

async function sockets() {
  const cookie = await anonymousSession();
  const ack = /** @type {{ ok?: unknown }} */ (await enterOverWebSocket(base, cookie));
  console.log(`enter ack: ${JSON.stringify(ack)}`);
  check(typeof ack?.ok === "boolean", "Socket.IO over WebSocket: enter gets an ack");
  const refused = await enterOverWebSocket("https://elsewhere.example", cookie).then(
    () => false,
    () => true,
  );
  check(refused, "a WebSocket from a foreign Origin is refused");
}

try {
  await health();
  await webApp();
  await sockets();
  console.log("smoke test passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
