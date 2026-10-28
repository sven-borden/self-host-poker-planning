/**
 * AC 2 of #36: fuzzed commands are rejected without crashing the room. A property test
 * drives the real server (Postgres, the real handshake, real guests) over real sockets
 * with random and malformed messages: wrong types, huge strings, deep objects, prototype
 * keys, unknown commands and events, binary frames, extra arguments, frames over the
 * 16 KB cap and frames Socket.IO cannot decode. Two attackers sit in the room (the PO and
 * a voter, so their commands reach `apply`), next to two honest people.
 *
 * Every message that asks for an answer gets an ack with `ok` or an error code (never
 * `internal`, never silence); the others are dropped. After each case the room's stored
 * state keeps `apply`'s invariants, the honest people still enter and act, nothing
 * touched `Object.prototype`, and the server logged no error. A flood against the
 * default limits and a fuzz of the HTTP bodies follow.
 *
 * `FUZZ_RUNS` sets the cases (40 by default, as CI runs it); `FUZZ_RUNS=1000` locally.
 */
import {
  apply,
  type Command,
  cardLength,
  cleanName,
  createRoom,
  deckCards,
  MAX_LINK_LENGTH,
  MAX_MEMBERS,
  MAX_TIMER_SECONDS,
  MAX_TITLE_LENGTH,
  MIN_TIMER_SECONDS,
  PRESET_DECK_IDS,
  ROLES,
  type RoomState,
  SPECIAL_CARDS,
  validateCustomDeck,
  WHO_CAN_REVEAL,
} from "@pp/domain";
import { ACK_ERROR_CODES, PROTOCOL_VERSION, snapshotSchema, WIRE_LIMITS } from "@pp/protocol";
import fc from "fast-check";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { createTestDatabase, type TestDatabase } from "./db/test-db.ts";
import { MAX_PAYLOAD_BYTES } from "./realtime.ts";
import { createServer, type PokerServer } from "./server.ts";
import { setupServer } from "./setup.ts";
import {
  type Guest,
  roomCode,
  signInGuest,
  type TestClient,
  testClient,
} from "./sync/test-support.ts";
import { HISTORY_LIMIT, ROSTER_LIMIT, SOCKET_MESSAGE_LIMIT } from "./sync/token-bucket.ts";
import { collectLogs, testConfig, VALID_ENV } from "./test-support.ts";

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);
const ORIGIN = VALID_ENV.BASE_URL;
const ACK_MS = 5_000;
const ERROR_LEVEL = 50;
const UNLIMITED = { perSecond: 1e6, burst: 1e6 };

type Instance = Awaited<ReturnType<typeof setupServer>> & { server: PokerServer; base: string };

async function startInstance(
  config: Config,
  logger: ReturnType<typeof collectLogs>["logger"],
  limited: boolean,
): Promise<Instance> {
  const setup = await setupServer(config, logger);
  const server = createServer(config, {
    ...setup.deps,
    logger,
    ...(!limited && {
      realtimeLimits: { messageLimit: UNLIMITED, rosterLimit: UNLIMITED, historyLimit: UNLIMITED },
    }),
  });
  const { port } = await server.listen();
  return { ...setup, server, base: `http://localhost:${port}` };
}

async function stopInstance(instance: Instance | undefined): Promise<void> {
  await instance?.server.close();
  await instance?.dispose?.();
}

/** An attacker's socket: anything may be sent on it. */
interface Attacker {
  guest: Guest;
  socket: Socket;
  /** The PO removed this person: the server closes their sockets. */
  kicked: boolean;
}

type Loose = {
  emit(event: string, ...args: unknown[]): void;
  timeout(ms: number): { emit(event: string, ...args: unknown[]): void };
};

/**
 * Sends with an ack and resolves with the answer, or `dropped` when the connection closed
 * first (the server closes a kicked person's sockets, or one that sent a broken frame).
 */
function ask(
  socket: Socket,
  event: string,
  args: unknown[],
): Promise<{ answer: unknown } | "dropped"> {
  if (socket.disconnected) return Promise.resolve("dropped");
  return new Promise((resolve, reject) => {
    const gone = () => resolve("dropped");
    socket.once("disconnect", gone);
    (socket as unknown as Loose)
      .timeout(ACK_MS)
      .emit(event, ...args, (error: unknown, answer: unknown) => {
        socket.off("disconnect", gone);
        if (error) reject(new Error(`no answer to ${event} in ${ACK_MS} ms`));
        else resolve({ answer });
      });
  });
}

let fixtureClock = 0;
/** Applies a fixture command; a refusal is a broken test. */
function step(state: RoomState, actor: string, command: Command): RoomState {
  fixtureClock = Math.max(Date.now(), fixtureClock + 1);
  const result = apply(state, command, { actor, now: fixtureClock });
  if (!result.ok) throw new Error(`fixture refused: ${result.error}`);
  return result.state;
}

function connectRaw(base: string, guest: Guest): Promise<Socket> {
  const socket = connect(base, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    extraHeaders: { cookie: guest.cookie },
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function disconnected(socket: Socket, ms: number): Promise<boolean> {
  if (socket.disconnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("disconnect", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** An answer the protocol allows: `ok`, or a known error code other than `internal`. */
/** How the answers fell, printed after the fuzz: proof that it reaches `apply`. */
const tally = new Map<string, number>();

function checkAck(answer: unknown, what: string): void {
  const ack = answer as { ok?: unknown; code?: unknown; snapshot?: unknown };
  expect(typeof ack === "object" && ack !== null, `${what}: an object`).toBe(true);
  const outcome = ack.ok === true ? "ok" : String(ack.code);
  tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
  if (ack.ok === true) {
    if (ack.snapshot !== undefined) snapshotSchema.parse(ack.snapshot);
    return;
  }
  expect(ack.ok, what).toBe(false);
  expect(ACK_ERROR_CODES, `${what}: ${String(ack.code)}`).toContain(ack.code);
  expect(ack.code, what).not.toBe("internal");
}

/** What `apply` promises about every state it returns. */
function invariantProblems(state: RoomState): string[] {
  const problems: string[] = [];
  const people = Object.entries(state.participants);
  if (people.length > MAX_MEMBERS) problems.push(`${people.length} members`);
  if (typeof state.ownerId !== "string" || state.ownerId === "") problems.push("no owner");
  for (const [id, person] of people) {
    if (cleanName(person.name) !== person.name) problems.push(`name of ${id} not clean`);
    if (!ROLES.includes(person.role)) problems.push(`role of ${id}`);
  }
  const { settings } = state;
  const deckOk = (deck: RoomState["settings"]["deck"]) =>
    deck.kind === "preset"
      ? PRESET_DECK_IDS.includes(deck.id)
      : validateCustomDeck(deck.cards).ok && deck.cards.length > 0;
  if (!deckOk(settings.deck)) problems.push("settings deck");
  if (!settings.specials.every((card) => SPECIAL_CARDS.includes(card))) problems.push("specials");
  if (!WHO_CAN_REVEAL.includes(settings.whoCanReveal)) problems.push("whoCanReveal");
  const seconds = settings.timer.seconds;
  if (
    seconds !== null &&
    !(Number.isInteger(seconds) && seconds >= MIN_TIMER_SECONDS && seconds <= MAX_TIMER_SECONDS)
  ) {
    problems.push(`timer ${seconds}`);
  }
  const round = state.round;
  if (round) {
    if (!Number.isInteger(round.number) || round.number < 1) problems.push("round number");
    if (!deckOk(round.deck)) problems.push("round deck");
    const cards = deckCards(round.deck, round.specials);
    for (const [who, vote] of Object.entries(round.votes)) {
      if (!cards.includes(vote.card)) problems.push(`vote of ${who} not in the deck`);
      if (round.phase === "voting" && state.participants[who]?.role !== "voter") {
        problems.push(`vote of ${who}, who is not a voter, while voting`);
      }
    }
    if (round.final !== undefined && !cards.includes(round.final)) problems.push("final");
    const subject = round.subject;
    if (subject.kind === "title" && cardLength(subject.text) > MAX_TITLE_LENGTH) {
      problems.push("title");
    }
    if (
      subject.kind === "link" &&
      (subject.url.length > MAX_LINK_LENGTH || !/^https?:\/\//.test(subject.url))
    ) {
      problems.push("link");
    }
  }
  return problems;
}

// ---- What the attackers send ----------------------------------------------------------

/** A message on the wire, and what may happen to it. */
type Message =
  /** Sent with an ack callback: must get an answer. */
  | { kind: "ack"; event: "cmd" | "enter" | "history"; args: unknown[] }
  /** Sent without a callback, or to an event the server does not know: dropped. */
  | { kind: "drop"; event: string; args: unknown[] }
  /** Over the 16 KB cap: the server closes the connection. */
  | { kind: "oversize" }
  /** A frame Socket.IO cannot decode. */
  | { kind: "frame"; data: string };

const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"];

/** The client encodes with JSON.stringify: a value it cannot encode never reaches the wire. */
const encodable = (value: unknown) => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

const junk = fc
  .anything({
    key: fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom(...PROTOTYPE_KEYS)),
    maxDepth: 3,
    maxKeys: 5,
    withNullPrototype: true,
    withTypedArray: true,
    withSparseArray: true,
  })
  .filter(encodable);

/** Text a person could type, and text nobody should. */
const text = (maxLength: number) =>
  fc.oneof(
    fc.string({ maxLength }),
    fc.constantFrom(
      "Mallory",
      "   ",
      "‮evil",
      "Zé́́́ro",
      "a\u0000b",
      "\u{1F3F4}\u{E0067}\u{E0062}",
      "\ud800",
      "x".repeat(MAX_TITLE_LENGTH + 1),
    ),
  );

/** A long string that still fits a frame: one unit repeated up to about 14 KB. */
const huge = fc
  .tuple(fc.constantFrom("x", "é", "\u{1F600}", "‮", "́"), fc.integer({ min: 500, max: 3_400 }))
  .map(([unit, times]) => unit.repeat(times));

const deep = fc.integer({ min: 50, max: 2_500 }).map((depth) => {
  let value: unknown = "bottom";
  for (let n = 0; n < depth; n++) value = n % 2 === 0 ? [value] : { a: value };
  return value;
});

const card = fc.oneof(
  fc.constantFrom("0", "1", "2", "3", "5", "8", "13", "?", "☕", "∞", "XL", "M"),
  fc.string({ maxLength: 6 }),
);
const role = fc.oneof(fc.constantFrom(...ROLES), fc.constantFrom("admin", ""));
const roundNumber = fc.oneof(
  fc.integer({ min: 1, max: 4 }),
  fc.constantFrom(0, -1, 1.5, WIRE_LIMITS.roundNumber, WIRE_LIMITS.roundNumber + 1, 2 ** 53),
);
const seconds = fc.oneof(
  fc.integer({ min: 0, max: 4_000 }),
  fc.constantFrom(-5, 2.5, 1e9, Number.MAX_VALUE, -0),
);
const subject = fc.oneof(
  fc.constant({ kind: "none" }),
  fc.record({ kind: fc.constant("title"), text: text(250) }),
  fc.record({
    kind: fc.constant("link"),
    url: fc.oneof(
      fc.webUrl(),
      fc.constantFrom(
        "javascript:alert(1)",
        "https://user:pw@jira.example.com/browse/PP-1",
        "ftp://example.com",
        `https://example.com/${"a".repeat(MAX_LINK_LENGTH)}`,
      ),
    ),
  }),
);
const deck = fc.oneof(
  fc.record({ kind: fc.constant("preset"), id: fc.constantFrom(...PRESET_DECK_IDS) }),
  fc.record({ kind: fc.constant("custom"), cards: fc.array(card, { maxLength: 24 }) }),
);
const patch = fc.record(
  {
    deck,
    specials: fc.subarray([...SPECIAL_CARDS]),
    whoCanReveal: fc.constantFrom(...WHO_CAN_REVEAL),
    revealNames: fc.boolean(),
    revealWhenAllVoted: fc.boolean(),
    timer: fc.record(
      { seconds: fc.oneof(fc.constant(null), seconds), revealAtEnd: fc.boolean() },
      { requiredKeys: [] },
    ),
    allowChangeAfterReveal: fc.boolean(),
    poVotes: fc.boolean(),
    observersCount: fc.boolean(),
  },
  { requiredKeys: [] },
);

/** Commands a client could send, mostly well formed, so that they reach `apply`. */
function commandArb(ids: () => string[]) {
  const who = fc.oneof(
    fc.constant(null).map(() => ids()[0] ?? "x"),
    fc.constant(null).map(() => ids()[1] ?? "x"),
    fc.constant(null).map(() => ids()[2] ?? "x"),
    fc.string({ maxLength: 10 }),
  );
  const restart = fc.option(fc.integer({ min: -1, max: 3 }), { nil: undefined });
  return fc.oneof(
    fc.record({ type: fc.constant("join"), payload: fc.record({ name: text(40), role }) }),
    fc.record({ type: fc.constant("leave") }),
    fc.record({ type: fc.constant("rename"), payload: fc.record({ name: text(40) }) }),
    fc.record({ type: fc.constant("setRole"), payload: fc.record({ role }) }),
    fc.record({ type: fc.constant("kick"), payload: fc.record({ who }) }),
    fc.record({ type: fc.constant("startRound"), payload: fc.record({ subject }) }),
    fc.record({
      type: fc.constant("castVote"),
      payload: fc.record(
        { card, round: roundNumber, restart },
        { requiredKeys: ["card", "round"] },
      ),
    }),
    fc.record({
      type: fc.constant("retractVote"),
      payload: fc.record({ round: roundNumber, restart }, { requiredKeys: ["round"] }),
    }),
    fc.record({ type: fc.constant("reveal") }),
    fc.record({ type: fc.constant("setFinal"), payload: fc.record({ card }) }),
    fc.record({ type: fc.constant("revote") }),
    fc.record({ type: fc.constant("startTimer"), payload: fc.record({ seconds }) }),
    fc.record({ type: fc.constant("stopTimer") }),
    fc.record({ type: fc.constant("extendTimer"), payload: fc.record({ seconds }) }),
    fc.record({ type: fc.constant("timeUp") }),
    fc.record({ type: fc.constant("updateSettings"), payload: fc.record({ patch }) }),
    fc.record({ type: fc.constant("transferOwner"), payload: fc.record({ to: who }) }),
    fc.record({ type: fc.constant("claimOwner") }),
    // The server's own commands and names that are no command at all.
    fc.record({
      type: fc.constantFrom("presence", "password", "timeUp ", "__proto__", "constructor"),
      payload: junk,
    }),
  );
}

const commandId = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
  // A few ids again and again, for the idempotency cache.
  fc.constantFrom("dup-1", "dup-2"),
);

/** One of the ways to spoil a well-formed command. */
const spoil = fc.constantFrom(
  "none",
  "none",
  "none",
  "junk payload",
  "extra field",
  "prototype key",
  "wrong id",
  "huge field",
  "deep payload",
  "binary payload",
);

function messageArb(code: () => string, ids: () => string[]): fc.Arbitrary<Message> {
  const cmd = fc
    .tuple(commandId, commandArb(ids), spoil, junk, huge, deep)
    .map(([id, command, how, noise, long, nested]): Message => {
      const base: Record<string, unknown> = { id, ...command };
      const payload = (base.payload ?? {}) as Record<string, unknown>;
      switch (how) {
        case "junk payload":
          base.payload = noise;
          break;
        case "extra field":
          base.payload = { ...payload, extra: noise };
          break;
        case "prototype key":
          // JSON.parse makes `__proto__` an own key, as the server's parser does.
          return {
            kind: "ack",
            event: "cmd",
            args: [
              JSON.parse(
                `{"id":"p","type":"rename","__proto__":{"polluted":true},"payload":{"name":"x","constructor":{"prototype":{"polluted":true}}}}`,
              ),
            ],
          };
        case "wrong id":
          base.id = noise;
          break;
        case "huge field":
          // One field, so the frame stays under the 16 KB cap.
          base.payload = { ...payload, [Object.keys(payload)[0] ?? "name"]: long };
          break;
        case "deep payload":
          base.payload = nested;
          break;
        case "binary payload":
          base.payload = Buffer.from(JSON.stringify(payload));
          break;
      }
      return { kind: "ack", event: "cmd", args: [base] };
    });
  return fc.oneof(
    { weight: 12, arbitrary: cmd },
    {
      weight: 2,
      arbitrary: junk.map((value): Message => ({ kind: "ack", event: "cmd", args: [value] })),
    },
    {
      weight: 2,
      arbitrary: fc
        .oneof(
          fc.constant(null).map(() => ({ code: code(), protocol: PROTOCOL_VERSION })),
          fc.record({ code: fc.oneof(fc.string(), huge), protocol: fc.integer() }),
          fc.constant(null).map(() => ({ code: code(), protocol: PROTOCOL_VERSION + 1 })),
          junk,
        )
        .map((payload): Message => ({ kind: "ack", event: "enter", args: [payload] })),
    },
    {
      weight: 2,
      arbitrary: fc
        .oneof(
          fc.record(
            {
              before: fc.oneof(roundNumber, fc.constantFrom(2 ** 31, -1, "3")),
              limit: fc.oneof(fc.integer({ min: -2, max: 60 }), fc.constant(1e9)),
            },
            { requiredKeys: [] },
          ),
          junk,
        )
        .map((payload): Message => ({ kind: "ack", event: "history", args: [payload] })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom(
            "cmd",
            "enter",
            "history",
            "snapshot",
            "kicked",
            "message",
            "toString",
            "__proto__",
            "x".repeat(300),
          ),
          junk,
        )
        .map(([event, value]): Message => ({ kind: "drop", event, args: [value] })),
    },
    {
      weight: 1,
      // Several arguments, or an ack that is not a function: still one answer at most.
      arbitrary: fc
        .tuple(fc.constantFrom<"cmd" | "enter" | "history">("cmd", "enter", "history"), junk, junk)
        .map(([event, a, b]): Message => ({ kind: "ack", event, args: [a, b, "not a function"] })),
    },
    { weight: 1, arbitrary: fc.constant<Message>({ kind: "oversize" }) },
    {
      weight: 1,
      arbitrary: fc
        // Socket.IO packets as the engine carries them: broken JSON, unknown types, a
        // binary event whose attachment never comes, another namespace, deep nesting.
        .constantFrom(
          '2["cmd",{',
          "2[",
          '2{"cmd":1}',
          "2",
          "9",
          "4{}",
          '51-["cmd",{"_placeholder":true,"num":7}]',
          '3["cmd"]',
          "0{",
          "1",
          '2/other,["cmd",{}]',
          `2["enter",${"[".repeat(5_000)}${"]".repeat(5_000)}]`,
        )
        .map((data): Message => ({ kind: "frame", data })),
    },
  );
}

/** A message, short enough for an assertion's label (binary and cycles included). */
function label(message: Message): string {
  try {
    return (JSON.stringify(message) ?? String(message.kind)).slice(0, 200);
  } catch {
    return message.kind;
  }
}

// ---- The fuzz ------------------------------------------------------------------------

describe("fuzzed socket messages (AC 2)", () => {
  const logs = collectLogs("info");
  let t: TestDatabase;
  let instance: Instance;
  let mallory: Guest;
  let eve: Guest;
  let ada: Guest;
  let bob: Guest;
  const attackers = new Map<string, Attacker>();
  const honest = new Map<string, TestClient>();
  let current = "";

  beforeAll(async () => {
    t = await createTestDatabase();
    instance = await startInstance(testConfig({ DATABASE_URL: t.url }), logs.logger, false);
    const guest = () => signInGuest(instance.base, ORIGIN);
    [mallory, eve, ada, bob] = await Promise.all([guest(), guest(), guest(), guest()]);
  });

  afterAll(async () => {
    for (const { socket } of attackers.values()) socket.disconnect();
    for (const client of honest.values()) client.close();
    await stopInstance(instance);
    await t?.drop();
  });

  /** Mallory (PO) and Eve fuzz; Ada and Bob vote honestly. */
  async function freshRoom(): Promise<string> {
    let state = createRoom({ ownerId: mallory.id });
    state = step(state, mallory.id, { type: "join", name: "Mallory", role: "voter" });
    state = step(state, eve.id, { type: "join", name: "Eve", role: "voter" });
    state = step(state, ada.id, { type: "join", name: "Ada", role: "voter" });
    state = step(state, bob.id, { type: "join", name: "Bob", role: "voter" });
    const code = roomCode();
    const stored = await instance.database.store.insertRoom({
      code,
      name: null,
      state,
      passwordHash: null,
    });
    if (!stored) throw new Error("code taken");
    return code;
  }

  async function attacker(guest: Guest): Promise<Attacker> {
    const known = attackers.get(guest.id);
    if (known?.socket.connected) return known;
    const fresh: Attacker = {
      guest,
      socket: await connectRaw(instance.base, guest),
      kicked: false,
    };
    fresh.socket.on("kicked", () => {
      fresh.kicked = true;
    });
    attackers.set(guest.id, fresh);
    return fresh;
  }

  async function honestClient(guest: Guest): Promise<TestClient> {
    const known = honest.get(guest.id);
    if (known?.socket.connected) return known;
    known?.close();
    const client = testClient(instance.base, { cookie: guest.cookie });
    await new Promise<void>((resolve, reject) => {
      client.socket.once("connect", () => resolve());
      client.socket.once("connect_error", reject);
    });
    honest.set(guest.id, client);
    return client;
  }

  async function enterAll(code: string): Promise<void> {
    for (const guest of [mallory, eve]) {
      const { socket } = await attacker(guest);
      const entered = await ask(socket, "enter", [{ code, protocol: PROTOCOL_VERSION }]);
      expect(entered).not.toBe("dropped");
      if (entered !== "dropped") checkAck(entered.answer, "enter");
    }
    for (const guest of [ada, bob]) {
      const ack = await (await honestClient(guest)).enter(code);
      expect(ack.ok).toBe(true);
    }
  }

  async function send(from: Guest, message: Message): Promise<void> {
    const sender = await attacker(from);
    const { socket } = sender;
    const what = label(message);
    switch (message.kind) {
      case "ack": {
        const sent = await ask(socket, message.event, message.args);
        if (sent === "dropped") {
          // Only a kick closes the connection of a client that sent a well-framed message.
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(sender.kicked, `${what}: closed without an answer`).toBe(true);
        } else {
          checkAck(sent.answer, what);
        }
        return;
      }
      case "drop":
        (socket as unknown as Loose).emit(message.event, ...message.args);
        return;
      case "oversize": {
        const gone = disconnected(socket, ACK_MS);
        socket.emit("cmd", {
          id: "big",
          type: "rename",
          payload: { name: "x".repeat(MAX_PAYLOAD_BYTES) },
        });
        expect(await gone, "an oversized frame closes the connection").toBe(true);
        return;
      }
      case "frame": {
        const gone = disconnected(socket, 300);
        (socket.io.engine as unknown as { write(data: string): void }).write(message.data);
        // Dropped either way: the connection closes, or the frame is ignored and the
        // next message is answered.
        if (await gone) return;
        const next = await ask(socket, "history", [{}]);
        if (next !== "dropped") checkAck(next.answer, what);
        return;
      }
    }
  }

  async function checkRoom(code: string): Promise<void> {
    const stored = await instance.database.store.loadRoom(code);
    expect(stored).not.toBeNull();
    expect(invariantProblems(stored?.state as RoomState)).toEqual([]);
    // The honest people still enter (a fresh, valid snapshot) and get answers.
    for (const guest of [ada, bob]) {
      const client = await honestClient(guest);
      const entered = await client.enter(code);
      expect(entered.ok).toBe(true);
      const inRoom = stored?.state.participants[guest.id] !== undefined;
      const ack = inRoom
        ? await client.cmd("rename", { name: guest === ada ? "Ada" : "Bob" })
        : await client.cmd("join", { name: guest === ada ? "Ada" : "Bob", role: "voter" });
      checkAck(ack, `honest ${inRoom ? "rename" : "join"}`);
    }
    // Nothing reached the prototypes, and nothing failed on the server.
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(logs.lines.filter((line) => Number(line.level) >= ERROR_LEVEL)).toEqual([]);
  }

  it(
    `answers or drops every message and keeps the room valid (${RUNS} cases)`,
    async () => {
      const message = messageArb(
        () => current,
        () => [mallory.id, eve.id, ada.id],
      );
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(fc.constantFrom("mallory", "eve"), message), {
            minLength: 1,
            maxLength: 25,
          }),
          async (messages) => {
            current = await freshRoom();
            await enterAll(current);
            for (const [who, sent] of messages) {
              const from = who === "mallory" ? mallory : eve;
              await send(from, sent);
              // A failed enter (a wrong code) leaves the room: come back for the next one.
              if (sent.kind !== "ack" || sent.event !== "enter") continue;
              const { socket } = await attacker(from);
              await ask(socket, "enter", [{ code: current, protocol: PROTOCOL_VERSION }]);
            }
            await checkRoom(current);
          },
        ),
        { numRuns: RUNS, endOnFailure: true },
      );
      console.info(
        `fuzz answers: ${[...tally]
          .sort((x, y) => y[1] - x[1])
          .map(([code, n]) => `${code} ${n}`)
          .join(", ")}`,
      );
      // Commands reached the domain: some passed, and the domain refused others.
      expect(tally.get("ok") ?? 0).toBeGreaterThan(0);
      expect(
        [...tally.keys()].filter(
          (code) => !["ok", "bad_payload", "rate_limited", "room_not_found"].includes(code),
        ).length,
      ).toBeGreaterThan(0);
      const health = await fetch(`${instance.base}/api/health`);
      expect(health.status).toBe(200);
    },
    Math.max(120_000, RUNS * 3_000),
  );

  it("fuzzed HTTP bodies get a code and a 4xx, never a 500", async () => {
    const code = await freshRoom();
    const routes = [
      { method: "POST", path: "/api/rooms" },
      { method: "POST", path: `/api/rooms/${code}/access` },
      { method: "PUT", path: `/api/rooms/${code}/password` },
      { method: "POST", path: "/api/me/name" },
      { method: "POST", path: "/api/auth/sign-in/anonymous" },
    ];
    const body = fc.oneof(
      fc.json(),
      junk.map((value) => {
        try {
          return JSON.stringify(value) ?? "null";
        } catch {
          return "null";
        }
      }),
      fc.string(),
      fc.constantFrom(
        '{"__proto__":{"polluted":true}}',
        '{"password":"' + "p".repeat(20_000) + '"}',
        "{",
        "",
      ),
      fc
        .record({ name: text(80), password: text(200), deck: fc.string() })
        .map((value) => JSON.stringify(value)),
    );
    let address = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...routes),
        body,
        fc.constantFrom("application/json", "application/json; charset=utf-8", "text/plain"),
        fc.boolean(),
        async (route, payload, type, signedIn) => {
          address += 1;
          const response = await fetch(`${instance.base}${route.path}`, {
            method: route.method,
            headers: {
              origin: ORIGIN,
              "content-type": type,
              // A client address each, so the per-address limits stay out of the way.
              "x-forwarded-for": `10.36.${(address >> 8) & 255}.${address & 255}`,
              ...(signedIn && { cookie: mallory.cookie }),
            },
            body: payload,
          });
          const what = `${route.method} ${route.path} ${payload.slice(0, 80)}`;
          expect([200, 201, 204, 400, 401, 403, 404, 413, 415, 429, 503], what).toContain(
            response.status,
          );
          const answer = await response.text();
          if (response.status >= 400) {
            const parsed = JSON.parse(answer) as { code?: unknown };
            expect(ACK_ERROR_CODES, what).toContain(parsed.code);
          }
        },
      ),
      { numRuns: Math.max(100, RUNS * 3) },
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(logs.lines.filter((line) => Number(line.level) >= ERROR_LEVEL)).toEqual([]);
  }, 120_000);
});

// ---- Floods against the default limits -----------------------------------------------

describe("a flood (default limits)", () => {
  const logs = collectLogs("info");
  let t: TestDatabase;
  let instance: Instance;

  beforeAll(async () => {
    t = await createTestDatabase();
    instance = await startInstance(testConfig({ DATABASE_URL: t.url }), logs.logger, true);
  });

  afterAll(async () => {
    await stopInstance(instance);
    await t?.drop();
  });

  it("is cut at the person's buckets, while the others keep playing", async () => {
    const [po, flooder] = await Promise.all([
      signInGuest(instance.base, ORIGIN),
      signInGuest(instance.base, ORIGIN),
    ]);
    let state = createRoom({ ownerId: po.id });
    state = step(state, po.id, { type: "join", name: "Ada", role: "voter" });
    state = step(state, flooder.id, { type: "join", name: "Eve", role: "voter" });
    state = step(state, po.id, { type: "startRound", subject: { kind: "none" } });
    const code = roomCode();
    await instance.database.store.insertRoom({ code, name: null, state, passwordHash: null });
    const ada = testClient(instance.base, { cookie: po.cookie });
    const eve = await connectRaw(instance.base, flooder);
    try {
      expect((await ada.enter(code)).ok).toBe(true);
      checkAck(
        await eve.timeout(ACK_MS).emitWithAck("enter", { code, protocol: PROTOCOL_VERSION }),
        "enter",
      );
      const flood: [string, unknown][] = [
        ...Array.from({ length: 150 }, (_, n): [string, unknown] => [
          "cmd",
          { id: `f${n}`, type: "castVote", payload: { card: "5", round: 1 } },
        ]),
        ...Array.from({ length: 40 }, (_, n): [string, unknown] => [
          "cmd",
          { id: `n${n}`, type: "rename", payload: { name: `Eve ${n}` } },
        ]),
        ...Array.from({ length: 40 }, (): [string, unknown] => ["history", {}]),
      ];
      for (let n = 0; n < 200; n++) (eve as unknown as Loose).emit("unknown", { n });
      const answers = await Promise.all(
        flood.map(async ([event, payload]) => {
          const sent = await ask(eve, event, [payload]);
          if (sent === "dropped") throw new Error("the flood closed the connection");
          return sent.answer;
        }),
      );
      for (const answer of answers) checkAck(answer, "flood");
      const codes = answers.map((answer) => (answer as { code?: string }).code ?? "ok");
      const limited = codes.filter((c) => c === "rate_limited").length;
      // At most a burst and what refilled meanwhile went through.
      expect(answers.length - limited).toBeLessThanOrEqual(SOCKET_MESSAGE_LIMIT.burst + 10);
      expect(limited).toBeGreaterThan(flood.length - SOCKET_MESSAGE_LIMIT.burst - 10);
      // The PO is another person, with buckets of her own: she votes and reveals at once.
      expect(await ada.cmd("castVote", { card: "8", round: 1 })).toMatchObject({ ok: true });
      // Eve's flooded vote was taken before her bucket ran dry: everyone voted, so the
      // round revealed itself.
      expect((await instance.database.store.loadRoom(code))?.state.round?.phase).toBe("revealed");
      // Eve's buckets refill: a moment later her messages pass again, the roster ones
      // once a token came back.
      await new Promise((resolve) =>
        setTimeout(resolve, (SOCKET_MESSAGE_LIMIT.burst / SOCKET_MESSAGE_LIMIT.perSecond) * 1000),
      );
      checkAck(await eve.timeout(ACK_MS).emitWithAck("history", {}), "history after the flood");
      expect(await eve.timeout(ACK_MS).emitWithAck("history", {})).toMatchObject({ ok: true });
      const stored = await instance.database.store.loadRoom(code);
      expect(invariantProblems(stored?.state as RoomState)).toEqual([]);
      expect(logs.lines.filter((line) => Number(line.level) >= ERROR_LEVEL)).toEqual([]);
      expect(ROSTER_LIMIT.burst).toBeLessThan(40);
      expect(HISTORY_LIMIT.burst).toBeLessThan(40);
    } finally {
      ada.close();
      eve.disconnect();
    }
  });
});
