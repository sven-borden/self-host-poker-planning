import type { ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";
import { roomCodeOf, scrub } from "./sentry.ts";

const ROOM = { origin: "https://poker.example.com", pathname: "/r/Abc1234567" };

describe("what leaves for Sentry (#40)", () => {
  it("finds the code of the room on screen", () => {
    expect(roomCodeOf("/r/Abc1234567")).toBe("Abc1234567");
    expect(roomCodeOf("/R//Abc1234567/")).toBe("Abc1234567");
    expect(roomCodeOf("/r/Abc%31234567")).toBe("Abc1234567");
    expect(roomCodeOf("/r/a")).toBeUndefined();
    expect(roomCodeOf("/r/%E0%A4%A")).toBeUndefined();
    expect(roomCodeOf("/")).toBeUndefined();
  });

  it("sends the route and the browser as the request, no user and no breadcrumbs", () => {
    const event = {
      event_id: "e",
      message: "room Abc1234567 failed at https://poker.example.com/r/Abc1234567?x=1",
      exception: {
        values: [{ type: "Error", value: "cannot load Abc1234567", stacktrace: { frames: [] } }],
      },
      request: { url: "https://poker.example.com/r/Abc1234567?x=1", headers: { Referer: "x" } },
      user: { id: "guest-1", ip_address: "{{auto}}" },
      breadcrumbs: [{ message: "GET /api/rooms/Abc1234567" }],
      extra: { Abc1234567: "Abc1234567" },
    } as unknown as ErrorEvent;
    const sent = scrub(event, ROOM, "Test UA");
    expect(sent).toEqual({
      event_id: "e",
      message: "room :code failed at https://poker.example.com/r/:code?x=1",
      exception: {
        values: [{ type: "Error", value: "cannot load :code", stacktrace: { frames: [] } }],
      },
      request: { url: "https://poker.example.com/r/:code", headers: { "User-Agent": "Test UA" } },
      extra: { ":code": ":code" },
    });
    expect(JSON.stringify(sent)).not.toContain("Abc1234567");
  });

  it("hides room paths on any page", () => {
    const sent = scrub(
      { message: "fetch /api/rooms/Xyz9876543 failed" } as unknown as ErrorEvent,
      { origin: "https://poker.example.com", pathname: "/" },
      "UA",
    );
    expect(sent.message).toBe("fetch /api/rooms/:code failed");
    expect(sent.request?.url).toBe("https://poker.example.com/");
  });
});
