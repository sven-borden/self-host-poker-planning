// The only start path: importing anything else under src/ never opens a port, connects to
// the database or reads the environment. `setupDatabase` migrates and opens the pool
// before the server listens.
import { setupDatabase } from "./database.ts";
import { processHooks, run } from "./run.ts";

await run(process.env, { ...processHooks(process), setup: setupDatabase });
