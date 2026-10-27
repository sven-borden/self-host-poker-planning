// The only start path: importing anything else under src/ never opens a port, connects to
// the database or reads the environment. `setupServer` migrates and opens the pool, then
// builds Better Auth on it, before the server listens.
import { processHooks, run } from "./run.ts";
import { setupServer } from "./setup.ts";

await run(process.env, { ...processHooks(process), setup: setupServer });
