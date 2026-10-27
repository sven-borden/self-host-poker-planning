/**
 * Version of the wire protocol between the web app and the server. Bump it on any
 * breaking change to a command, snapshot or event, so an old client can be told to reload.
 *
 * - 1: the first deployed protocol (#12).
 * - 2: the `busy` ack code (#15), which a version 1 client cannot parse.
 * - 3: the `away` and `back` causes (#17, presence), which a version 2 client cannot parse.
 * - 4: `castVote` and `retractVote` carry their `round`, and the `round_changed` ack code
 *   (#18), which a version 3 client neither sends nor parses.
 * - 5: `castVote` and `retractVote` carry the round's `restart` too, and a round view its
 *   `restarts` (#26): a deck change restarts the round under the same number.
 */
export const PROTOCOL_VERSION = 5;
