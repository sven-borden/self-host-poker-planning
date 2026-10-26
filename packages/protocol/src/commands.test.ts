import type { Cause, Command, ErrorCode, Results, RoomSettings, Subject } from "@pp/domain";
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { toDomainCommand, WIRE_LIMITS, wireCommandSchema } from "./commands.ts";
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
import { commandArb, meta, play, scenarioArb } from "./test-support.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const jsonRoundTrip = <T>(schema: z.ZodType<T>, value: T) =>
  schema.parse(JSON.parse(JSON.stringify(value)));

const idArb = fc.string({ minLength: 1, maxLength: WIRE_LIMITS.commandId });

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
      fc.property(idArb, commandArb, (id, generated) => {
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

  it("strip unknown fields, a link's key included (the server detects it)", () => {
    expect(
      toDomainCommand({
        id: "1",
        type: "startRound",
        extra: true,
        payload: { subject: { kind: "link", url: "https://x.test", key: "AB-1" }, card: "5" },
      }),
    ).toStrictEqual({
      ok: true,
      id: "1",
      command: { type: "startRound", subject: { kind: "link", url: "https://x.test" } },
    });
    expect(
      toDomainCommand({
        id: "2",
        type: "updateSettings",
        payload: { patch: { revealNames: false, password: "x", timer: { seconds: 30, x: 1 } } },
      }),
    ).toStrictEqual({
      ok: true,
      id: "2",
      command: { type: "updateSettings", patch: { revealNames: false, timer: { seconds: 30 } } },
    });
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
    ["an unknown type", { id: "1", type: "dropTable" }],
    ["a prototype key as type", { id: "1", type: "__proto__" }],
    ["an inherited key as type", { id: "1", type: "toString" }],
    ["a payload that is not an object", { id: "1", type: "reveal", payload: 5 }],
    ["a payload that is an array", { id: "1", type: "castVote", payload: ["5"] }],
    ["a missing field", { id: "1", type: "castVote", payload: {} }],
    ["a numeric card", { id: "1", type: "castVote", payload: { card: 5 } }],
    [
      "a card past the wire cap",
      { id: "1", type: "castVote", payload: { card: "1".repeat(WIRE_LIMITS.card + 1) } },
    ],
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
        commandArb,
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
    expect(parseEnter({ room: 42, protocol: 0 })).toStrictEqual({
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
