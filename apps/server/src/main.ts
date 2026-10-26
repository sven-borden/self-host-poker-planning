// The only start path: importing anything else under src/ never opens a port, connects to
// the database or reads the environment.
import { run, type Signal } from "./run.ts";

await run(process.env, {
  exit: (code) => process.exit(code),
  onSignal: (handler) => {
    for (const signal of ["SIGTERM", "SIGINT"] satisfies Signal[]) {
      process.on(signal, () => handler(signal));
    }
  },
});
