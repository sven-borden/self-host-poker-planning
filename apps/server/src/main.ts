// The only start path: importing anything else under src/ never opens a port, connects to
// the database or reads the environment. `setupServer` migrates and opens the pool, then
// builds Better Auth on it, before the server listens. `vault:rotate` starts no server: it
// is the one-off command of ADR-026, run beside a server that keeps running.
import { processHooks, run } from "./run.ts";
import { setupServer } from "./setup.ts";

if (process.argv[2] === "vault:rotate") {
  const { runVaultRotation } = await import("./vault-rotation.ts");
  process.exitCode = await runVaultRotation(process.env);
} else {
  await run(process.env, { ...processHooks(process), setup: setupServer });
}
