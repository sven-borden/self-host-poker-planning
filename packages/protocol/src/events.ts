/**
 * The Socket.IO event maps. Both apps pass them to Socket.IO's generics
 * (`Server<ClientToServerEvents, ServerToClientEvents>`, `Socket<ServerToClientEvents,
 * ClientToServerEvents>`). The types describe what a well-behaved peer sends; the server
 * still parses every payload (`parseEnter`, `toDomainCommand`), it never trusts them.
 */
import type { WireCommandInput } from "./commands.ts";
import type { ProtocolErrorCode } from "./errors.ts";
import {
  type CmdAck,
  type EnterAck,
  type EnterPayload,
  enterPayloadSchema,
  type Snapshot,
} from "./schemas.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export interface ClientToServerEvents {
  /** Subscribe this socket to a room; the ack carries the first snapshot. */
  enter: (payload: EnterPayload, ack: (ack: EnterAck) => void) => void;
  /** One domain command; the ack carries the room's new version or an error code. */
  cmd: (command: WireCommandInput, ack: (ack: CmdAck) => void) => void;
}

export interface ServerToClientEvents {
  /** The room as this socket's user may see it, after every change. */
  snapshot: (snapshot: Snapshot) => void;
  /** This user was removed from the room; the server disconnects the socket next. */
  kicked: () => void;
  /**
   * The PO set or changed the room's password and this user is not in the room (#31): the
   * socket left it, and its next `enter` asks for the password. An older client ignores it.
   */
  locked: () => void;
}

export type ParsedEnter =
  | { ok: true; enter: EnterPayload }
  | { ok: false; code: Extract<ProtocolErrorCode, "bad_payload" | "protocol_mismatch"> };

/**
 * Parses what a socket sent with `enter`. Any `protocol` number other than
 * `PROTOCOL_VERSION` answers `protocol_mismatch`, before the rest of the payload is
 * looked at: an older client may send another shape, and it must learn to reload.
 */
export function parseEnter(input: unknown): ParsedEnter {
  if (typeof input === "object" && input !== null && "protocol" in input) {
    const { protocol } = input;
    if (typeof protocol === "number" && protocol !== PROTOCOL_VERSION) {
      return { ok: false, code: "protocol_mismatch" };
    }
  }
  const parsed = enterPayloadSchema.safeParse(input);
  return parsed.success ? { ok: true, enter: parsed.data } : { ok: false, code: "bad_payload" };
}
