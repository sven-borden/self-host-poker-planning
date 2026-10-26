import { createServer, type Server } from "node:http";
import { MAX_PARTICIPANTS } from "@pp/domain";
import { PROTOCOL_VERSION } from "@pp/protocol";

/** Placeholder until #6 brings Hono and Socket.IO. Creating it opens nothing. */
export function createApp(): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      `Poker Planning server (protocol v${PROTOCOL_VERSION}, up to ${MAX_PARTICIPANTS} per room)\n`,
    );
  });
}
