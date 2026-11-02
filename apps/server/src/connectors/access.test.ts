/**
 * A refresh in the orders a database test cannot force: the winner of a race still on its way
 * when the loser is refused. The store here is a row in memory with `replaceToken`'s rule.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AccountId,
  ConnectorTokenStore,
  ReplaceTokenResult,
  TokenVersion,
} from "../db/connector-tokens.ts";
import { Secret } from "../vault.ts";
import { createConnectorAccess, REFUSED_REFRESH_WAIT_MS, sealGrant } from "./access.ts";
import { type Grant, type Outcome, success } from "./connector.ts";

const ME = "me" as AccountId;
const NOW = 1_000_000;
const grant = (name: string, expiresAt = NOW + 3_600_000): Grant => ({
  accessToken: new Secret(`access-${name}`),
  refreshToken: new Secret(`refresh-${name}`),
  expiresAt,
});
const OLD = grant("old", NOW);

/** One row, and the two calls that compare its version. */
function memoryStore(start: Secret | null) {
  const row = { token: start, version: 1 };
  const version = () => String(row.version) as TokenVersion;
  const store = {
    readToken: async () =>
      row.token === null
        ? { status: "not_connected" as const }
        : { status: "ok" as const, token: row.token, version: version() },
    replaceToken: async (_a, _c, read, token): Promise<ReplaceTokenResult> => {
      if (row.token === null) return { status: "gone" };
      if (read !== version()) return { status: "changed" };
      row.token = token;
      row.version += 1;
      return { status: "replaced", version: version() };
    },
    dropToken: async (_a, _c, read) => {
      if (row.token === null || read !== version()) return false;
      row.token = null;
      return true;
    },
  } as Pick<ConnectorTokenStore, "readToken" | "replaceToken" | "dropToken">;
  return { row, store: store as ConnectorTokenStore };
}

const useToken = async (token: Secret) => success(token.reveal());

describe("a refused refresh", () => {
  it("waits for a winner still on its way, and takes its token", async () => {
    const { row, store } = memoryStore(sealGrant(OLD));
    let finish: (answer: Outcome<Grant>) => void = () => {};
    const winnerAtTheTracker = new Promise<Outcome<Grant>>((resolve) => {
      finish = resolve;
    });
    let written = () => {};
    const winnerWrote = new Promise<void>((resolve) => {
      written = resolve;
    });
    const refresh = vi
      .fn<(token: Secret) => Promise<Outcome<Grant>>>()
      .mockReturnValueOnce(winnerAtTheTracker)
      .mockResolvedValueOnce({ ok: false, code: "connector_reconnect" });
    const connector = { name: "jira" as const, refresh };
    const options = { now: () => NOW };
    const winner = createConnectorAccess(store, connector, options);
    const loser = createConnectorAccess(store, connector, {
      ...options,
      // The winner's answer lands during the wait, as a slower round trip would.
      wait: async (ms) => {
        expect(ms).toBe(REFUSED_REFRESH_WAIT_MS);
        finish(success(grant("new")));
        await winnerWrote;
      },
    });
    const first = winner.withToken(ME, useToken).then((answer) => {
      written();
      return answer;
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const second = loser.withToken(ME, useToken);
    await expect(first).resolves.toEqual({ ok: true, value: "access-new" });
    await expect(second).resolves.toEqual({ ok: true, value: "access-new" });
    expect(row.token).not.toBeNull();
  });

  it("is believed when nobody wrote: the row goes, and the person connects again", async () => {
    const { row, store } = memoryStore(sealGrant(OLD));
    const connector = {
      name: "jira" as const,
      refresh: async (): Promise<Outcome<Grant>> => ({ ok: false, code: "connector_reconnect" }),
    };
    const access = createConnectorAccess(store, connector, {
      now: () => NOW,
      wait: async () => {},
    });
    await expect(access.withToken(ME, useToken)).resolves.toEqual({
      ok: false,
      code: "connector_reconnect",
    });
    expect(row.token).toBeNull();
  });
});

describe("a token refused after a refresh", () => {
  const refused = async (): Promise<Outcome<string>> => ({
    ok: false,
    code: "connector_reconnect",
  });

  function renewing() {
    let n = 0;
    return vi.fn(async (): Promise<Outcome<Grant>> => {
      n += 1;
      return success(grant(`new-${n}`));
    });
  }

  it("is the app's setup: the row stays, and later calls spend no rotation", async () => {
    const { row, store } = memoryStore(sealGrant(grant("live")));
    const refresh = renewing();
    const access = createConnectorAccess(store, { name: "jira", refresh }, { now: () => NOW });
    const setup = { ok: false, code: "connector_setup" };
    await expect(access.withToken(ME, refused)).resolves.toEqual(setup);
    await expect(access.withToken(ME, refused)).resolves.toEqual(setup);
    await expect(access.withToken(ME, refused)).resolves.toEqual(setup);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(row.token).not.toBeNull();
  });

  it("is forgotten once the token works, so a later refusal gets its refresh", async () => {
    const { store } = memoryStore(sealGrant(grant("live")));
    const refresh = renewing();
    const access = createConnectorAccess(store, { name: "jira", refresh }, { now: () => NOW });
    await access.withToken(ME, refused);
    await expect(access.withToken(ME, useToken)).resolves.toMatchObject({ ok: true });
    await access.withToken(ME, refused);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not stand for one that a refresh cures", async () => {
    const { store } = memoryStore(sealGrant(grant("live")));
    const refresh = renewing();
    const access = createConnectorAccess(store, { name: "jira", refresh }, { now: () => NOW });
    const firstRefused = vi.fn(useToken);
    firstRefused.mockImplementationOnce(refused as never);
    await expect(access.withToken(ME, firstRefused)).resolves.toEqual({
      ok: true,
      value: "access-new-1",
    });
  });
});

describe("a row it cannot use", () => {
  it("counts as not connected when the sealed value is not a grant", async () => {
    for (const value of ["not json", "{}", '{"a":"x"}']) {
      const { store } = memoryStore(new Secret(value));
      const refresh = vi.fn();
      const access = createConnectorAccess(store, { name: "jira", refresh });
      const call = vi.fn(useToken);
      await expect(access.withToken(ME, call)).resolves.toEqual({
        ok: false,
        code: "connector_not_connected",
      });
      expect(call).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    }
  });
});
