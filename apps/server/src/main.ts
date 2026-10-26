// The only start path: importing anything else under src/ must never open a port.
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);

createApp().listen(port, () => {
  console.log(`Poker Planning server listening on http://localhost:${port}`);
});
