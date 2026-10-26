import { connect } from "node:net";
import { describe, expect, it } from "vitest";

// Placeholder for the `db` Vitest project until #7 brings Drizzle and real integration
// tests: it proves that `pnpm test:db` sees a Postgres at DATABASE_URL. It only opens a
// TCP connection (no driver, no login) and never prints the URL, which holds a password.

const MISSING_URL =
  "DATABASE_URL is not set. `pnpm test:db` needs a running Postgres: start one (for " +
  "example `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pp postgres:17`) and set " +
  "DATABASE_URL=postgres://postgres:pp@localhost:5432/postgres.";

function databaseAddress(): { host: string; port: number } {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error(MISSING_URL);
  const url = new URL(raw);
  return { host: url.hostname, port: url.port ? Number(url.port) : 5432 };
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<true> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`No answer from ${host}:${port} within ${timeoutMs} ms`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      const reason = error.message || (error as NodeJS.ErrnoException).code;
      reject(new Error(`Cannot reach Postgres at ${host}:${port}: ${reason}`));
    });
  });
}

describe("Postgres at DATABASE_URL", () => {
  it("accepts a TCP connection", async () => {
    const { host, port } = databaseAddress();
    await expect(canConnect(host, port, 5000)).resolves.toBe(true);
  });
});
