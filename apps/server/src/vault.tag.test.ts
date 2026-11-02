/**
 * The length of the GCM tag is held twice, and each hold has its own test: `SEALED` wants 22
 * characters (16 bytes) before any decryption starts, and `authTagLength` makes Node refuse a
 * shorter tag at the decipher. Node accepts a 4-byte tag without that option, and a test that
 * only looked at the answer could not tell which guard held, as either one makes a short tag
 * `corrupt`. So these watch the call to Node as well. `node:crypto` is wrapped, not replaced.
 */
import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Secret, Vault } from "./vault.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createDecipheriv: vi.fn(actual.createDecipheriv),
    createCipheriv: vi.fn(actual.createCipheriv),
  };
});

const ALICE = { userId: "user-alice", connector: "jira" };
const newKey = () => crypto.randomBytes(32).toString("base64");

describe("the length of the tag", () => {
  const vault = new Vault(newKey());
  const sealed = vault.seal(new Secret("fake-connector-token"), ALICE);
  const parts = sealed.split(".");

  beforeEach(() => {
    vi.mocked(crypto.createDecipheriv).mockClear();
  });

  it("is 16 bytes in what seal writes, and seal asks Node for 16", () => {
    expect(Buffer.from(parts[3] as string, "base64url")).toHaveLength(16);
    vi.mocked(crypto.createCipheriv).mockClear();
    vault.seal(new Secret("x"), ALICE);
    expect(vi.mocked(crypto.createCipheriv).mock.calls[0]?.[3]).toEqual({ authTagLength: 16 });
  });

  it("is checked by the pattern before any decryption: a tag cut to 6 characters", () => {
    const cut = [...parts];
    // The first 4 bytes of the real tag: 6 characters, spelled the one canonical way, so only
    // the length can turn this away.
    cut[3] = Buffer.from(cut[3] as string, "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(cut[3]).toHaveLength(6);
    expect(vault.open(cut.join("."), ALICE)).toEqual({ ok: false, cause: "corrupt" });
    // Fails if the pattern lets it through: the decipher would then be built.
    expect(crypto.createDecipheriv).not.toHaveBeenCalled();
  });

  it("is checked again by Node's own option, which every open passes", () => {
    expect(vault.open(sealed, ALICE)).toMatchObject({ ok: true });
    // Fails if `authTagLength` goes: Node then accepts a tag of 4 bytes, and only the pattern
    // stands between a short tag and a decipher.
    expect(vi.mocked(crypto.createDecipheriv).mock.calls[0]?.[3]).toEqual({ authTagLength: 16 });
  });
});
