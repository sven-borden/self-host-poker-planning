import type { Cause, Command, ErrorCode, Results, RoomSettings, Subject } from "@pp/domain";
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { COMMAND_ID_PATTERN, toDomainCommand, WIRE_LIMITS, wireCommandSchema } from "./commands.ts";
import { ACK_ERROR_CODES, type AckErrorCode, PROTOCOL_ERROR_CODES } from "./errors.ts";
import { parseEnter } from "./events.ts";
import { toSnapshot } from "./project.ts";
import {
  type CauseView,
  causeSchema,
  cmdAckSchema,
  enterAckSchema,
  enterPayloadSchema,
  type ResultsView,
  type RoomSettingsView,
  roomSettingsSchema,
  type SubjectView,
} from "./schemas.ts";
import { clientCommandArb, meta, play, scenarioArb } from "./test-support.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const jsonRoundTrip = <T>(schema: z.ZodType<T>, value: T) =>
  schema.parse(JSON.parse(JSON.stringify(value)));

const idArb = fc.stringMatching(COMMAND_ID_PATTERN);

/** fast-check may build objects without a prototype; a JSON copy makes them plain. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A domain command as a client sends it. */
function toWire(id: string, command: Command) {
  const { type, ...payload } = command;
  return { id, type, payload };
}

describe("types", () => {
  it("mirror the domain", () => {
    expectTypeOf<(typeof ACK_ERROR_CODES)[number]>().toEqualTypeOf<AckErrorCode>();
    expectTypeOf<ErrorCode>().toExtend<AckErrorCode>();
    expectTypeOf<RoomSettingsView>().toEqualTypeOf<RoomSettings>();
    expectTypeOf<SubjectView>().toEqualTypeOf<Subject>();
    expectTypeOf<ResultsView>().toEqualTypeOf<Results>();
    expectTypeOf<CauseView>().toEqualTypeOf<Cause>();
  });

  it("list every ack code once, all snake_case", () => {
    expect(new Set(ACK_ERROR_CODES).size).toBe(ACK_ERROR_CODES.length);
    for (const code of ACK_ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    for (const code of PROTOCOL_ERROR_CODES) expect(ACK_ERROR_CODES).toContain(code);
  });
});

describe("wire commands", () => {
  it("round-trip through JSON and the schema, and map back to the same domain command", () => {
    fc.assert(
      fc.property(idArb, clientCommandArb, (id, generated) => {
        const command = plain(generated);
        const wire = toWire(id, command);
        expect(jsonRoundTrip(wireCommandSchema, wire)).toStrictEqual(wire);
        expect(toDomainCommand(JSON.parse(JSON.stringify(wire)))).toStrictEqual({
          ok: true,
          id,
          command,
        });
      }),
      { numRuns: 500 },
    );
  });

  it("may leave out an empty payload", () => {
    expect(toDomainCommand({ id: "1", type: "reveal" })).toStrictEqual({
      ok: true,
      id: "1",
      command: { type: "reveal" },
    });
  });

  it("take a vote and a retract without their restart, as a tab from before #26 sends them", () => {
    expect(
      toDomainCommand({ id: "1", type: "castVote", payload: { card: "5", round: 1 } }),
    ).toStrictEqual({ ok: true, id: "1", command: { type: "castVote", card: "5", round: 1 } });
    expect(toDomainCommand({ id: "1", type: "retractVote", payload: { round: 1 } })).toStrictEqual({
      ok: true,
      id: "1",
      command: { type: "retractVote", round: 1 },
    });
  });

  it("accept ids of letters, digits, dash and underscore, up to the cap", () => {
    const id = `aZ09_-${"x".repeat(WIRE_LIMITS.commandId - 6)}`;
    expect(toDomainCommand({ id, type: "reveal" })).toMatchObject({ ok: true, id });
  });

  it("leave the exact rules to the domain", () => {
    // Too long for the domain (32 characters), short enough for the wire: the domain answers.
    const name = "a".repeat(100);
    expect(
      toDomainCommand({ id: "1", type: "join", payload: { name, role: "voter" } }),
    ).toMatchObject({ ok: true, command: { name } });
    expect(
      toDomainCommand({ id: "1", type: "startTimer", payload: { seconds: 2.5 } }),
    ).toMatchObject({ ok: true });
  });

  const junk: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "castVote"],
    ["an array", [{ id: "1", type: "reveal" }]],
    ["an empty object", {}],
    ["no id", { type: "reveal" }],
    ["an empty id", { id: "", type: "reveal" }],
    ["a long id", { id: "x".repeat(WIRE_LIMITS.commandId + 1), type: "reveal" }],
    ["a numeric id", { id: 1, type: "reveal" }],
    ["an id with a space", { id: "a b", type: "reveal" }],
    ["an id with a dot", { id: "a.b", type: "reveal" }],
    ["an id with an accent", { id: "café", type: "reveal" }],
    ["an id with an emoji", { id: "\u{1F600}", type: "reveal" }],
    ["an id with a lone surrogate", { id: "\ud800", type: "reveal" }],
    ["an unknown field on the command", { id: "1", type: "reveal", extra: true }],
    ["an unknown field in an empty payload", { id: "1", type: "reveal", payload: { x: 1 } }],
    [
      "an unknown field in a payload",
      { id: "1", type: "castVote", payload: { card: "5", round: 1, x: 1 } },
    ],
    [
      "a misspelt settings key next to a valid one",
      {
        id: "1",
        type: "updateSettings",
        payload: { patch: { revealName: false, poVotes: false } },
      },
    ],
    [
      "an unknown timer key",
      { id: "1", type: "updateSettings", payload: { patch: { timer: { seconds: 30, x: 1 } } } },
    ],
    [
      "an unknown deck field",
      {
        id: "1",
        type: "updateSettings",
        payload: { patch: { deck: { kind: "preset", id: "fib", cards: ["1"] } } },
      },
    ],
    [
      "a link subject with a key (the server detects it)",
      {
        id: "1",
        type: "startRound",
        payload: { subject: { kind: "link", url: "https://x.test", key: "AB-1" } },
      },
    ],
    [
      "an unknown field on a title subject",
      { id: "1", type: "startRound", payload: { subject: { kind: "title", text: "a", x: 1 } } },
    ],
    ["an unknown type", { id: "1", type: "dropTable" }],
    [
      "the server's own presence update",
      { id: "1", type: "presence", payload: { who: "a", connected: false } },
    ],
    ["a presence update without payload", { id: "1", type: "presence" }],
    ["a prototype key as type", { id: "1", type: "__proto__" }],
    ["an inherited key as type", { id: "1", type: "toString" }],
    ["a payload that is not an object", { id: "1", type: "reveal", payload: 5 }],
    ["a payload that is an array", { id: "1", type: "castVote", payload: ["5"] }],
    ["a missing field", { id: "1", type: "castVote", payload: {} }],
    ["a numeric card", { id: "1", type: "castVote", payload: { card: 5, round: 1 } }],
    [
      "a card past the wire cap",
      { id: "1", type: "castVote", payload: { card: "1".repeat(WIRE_LIMITS.card + 1), round: 1 } },
    ],
    ["a vote without its round", { id: "1", type: "castVote", payload: { card: "5" } }],
    ["a retract without its round", { id: "1", type: "retractVote" }],
    ["a round 0", { id: "1", type: "retractVote", payload: { round: 0 } }],
    ["a fractional round", { id: "1", type: "castVote", payload: { card: "5", round: 1.5 } }],
    ["a round as text", { id: "1", type: "retractVote", payload: { round: "1" } }],
    [
      "a negative restart",
      { id: "1", type: "castVote", payload: { card: "5", round: 1, restart: -1 } },
    ],
    ["a fractional restart", { id: "1", type: "retractVote", payload: { round: 1, restart: 0.5 } }],
    [
      "a name past the wire cap",
      {
        id: "1",
        type: "join",
        payload: { name: "a".repeat(WIRE_LIMITS.name + 1), role: "voter" },
      },
    ],
    ["an unknown role", { id: "1", type: "setRole", payload: { role: "admin" } }],
    ["NaN seconds", { id: "1", type: "startTimer", payload: { seconds: Number.NaN } }],
    [
      "infinite seconds",
      { id: "1", type: "extendTimer", payload: { seconds: Number.POSITIVE_INFINITY } },
    ],
    ["seconds as a string", { id: "1", type: "startTimer", payload: { seconds: "30" } }],
    [
      "an unknown subject kind",
      { id: "1", type: "startRound", payload: { subject: { kind: "jira" } } },
    ],
    [
      "an unknown special",
      { id: "1", type: "updateSettings", payload: { patch: { specials: ["!"] } } },
    ],
    [
      "a deck past the wire cap",
      {
        id: "1",
        type: "updateSettings",
        payload: {
          patch: { deck: { kind: "custom", cards: Array.from({ length: 65 }, (_, i) => `${i}`) } },
        },
      },
    ],
    [
      "an unknown preset",
      {
        id: "1",
        type: "updateSettings",
        payload: { patch: { deck: { kind: "preset", id: "x" } } },
      },
    ],
    ["a user id past the cap", { id: "1", type: "kick", payload: { who: "u".repeat(129) } }],
  ];

  it.each(junk)("refuse %s with bad_payload", (_, input) => {
    expect(toDomainCommand(input)).toStrictEqual({ ok: false, code: "bad_payload" });
  });

  it("never throw, and accept only what the schema accepts", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const parsed = toDomainCommand(input);
        expect(parsed.ok).toBe(wireCommandSchema.safeParse(input).success);
        if (!parsed.ok) expect(parsed.code).toBe("bad_payload");
      }),
      { numRuns: 500 },
    );
  });

  it("refuse a valid command whose payload was swapped for junk", () => {
    fc.assert(
      fc.property(
        idArb,
        clientCommandArb,
        fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null), fc.array(fc.nat())),
        (id, command, payload) => {
          expect(toDomainCommand({ id, type: command.type, payload })).toStrictEqual({
            ok: false,
            code: "bad_payload",
          });
        },
      ),
    );
  });
});

describe("enter", () => {
  it("accepts the current protocol and round-trips", () => {
    const enter = { code: "roomcode", protocol: PROTOCOL_VERSION };
    expect(parseEnter(enter)).toStrictEqual({ ok: true, enter });
    expect(jsonRoundTrip(enterPayloadSchema, enter)).toStrictEqual(enter);
  });

  it("answers protocol_mismatch to another version, whatever else it sent", () => {
    expect(parseEnter({ code: "roomcode", protocol: PROTOCOL_VERSION + 1 })).toStrictEqual({
      ok: false,
      code: "protocol_mismatch",
    });
    expect(parseEnter({ room: 42, protocol: 0, extra: true })).toStrictEqual({
      ok: false,
      code: "protocol_mismatch",
    });
  });

  it.each<[string, unknown]>([
    ["nothing", undefined],
    ["no protocol", { code: "roomcode" }],
    ["a protocol as a string", { code: "roomcode", protocol: "1" }],
    ["no code", { protocol: PROTOCOL_VERSION }],
    ["an empty code", { code: "", protocol: PROTOCOL_VERSION }],
    ["a long code", { code: "c".repeat(WIRE_LIMITS.roomCode + 1), protocol: PROTOCOL_VERSION }],
    ["an unknown field", { code: "roomcode", protocol: PROTOCOL_VERSION, password: "x" }],
  ])("answers bad_payload to %s", (_, input) => {
    expect(parseEnter(input)).toStrictEqual({ ok: false, code: "bad_payload" });
  });
});

describe("acks, settings and causes", () => {
  it("round-trip through JSON and their schema", () => {
    const ackArb = fc.oneof(
      fc.record({ ok: fc.constant(true as const), version: fc.nat() }),
      fc.record({ ok: fc.constant(false as const), code: fc.constantFrom(...ACK_ERROR_CODES) }),
    );
    fc.assert(
      fc.property(ackArb, (generated) => {
        const ack = plain(generated);
        expect(jsonRoundTrip(cmdAckSchema, ack)).toStrictEqual(ack);
      }),
    );
    fc.assert(
      fc.property(scenarioArb, (steps) => {
        for (const frame of play(steps)) {
          const snapshot = toSnapshot(frame.state, "ub", meta(frame));
          const ack = { ok: true as const, snapshot };
          expect(jsonRoundTrip(enterAckSchema, ack)).toStrictEqual(ack);
          expect(jsonRoundTrip(roomSettingsSchema, snapshot.room.settings)).toStrictEqual(
            snapshot.room.settings,
          );
          for (const cause of snapshot.causes) {
            expect(jsonRoundTrip(causeSchema, cause)).toStrictEqual(cause);
          }
        }
      }),
      { numRuns: 50 },
    );
    const refused = { ok: false as const, code: "password_required" as const };
    expect(jsonRoundTrip(enterAckSchema, refused)).toStrictEqual(refused);
  });

  it("refuse an unknown ack code", () => {
    expect(cmdAckSchema.safeParse({ ok: false, code: "Room is full." }).success).toBe(false);
  });
});
