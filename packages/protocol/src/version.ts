/**
 * Version of the wire protocol between the web app and the server. Bump it on any
 * breaking change to a command, snapshot or event, so an old client can be told to reload.
 *
 * - 1: the first deployed protocol (#12).
 * - 2: the `busy` ack code (#15), which a version 1 client cannot parse.
 * - 3: the `away` and `back` causes (#17, presence), which a version 2 client cannot parse.
 * - 4: `castVote` and `retractVote` carry their `round`, and the `round_changed` ack code
 *   (#18), which a version 3 client neither sends nor parses.
 *
 * Not breaking, so not bumped: an optional field on an outbound view (the web checks
 * shapes), or an optional field on an inbound command, such as the `restart` of
 * `castVote` and `retractVote` and the round view's `restarts` (#26), the room view's
 * `ownerClaimableAt` (#30), the `revealed` cause's `who` (#28), and the settings'
 * `hasPassword` with the `password` of `settingsUpdated` (#31). Nor is a new ack code
 * such as `too_few_cards` (#28): an older client words an unknown code generically. New
 * HTTP-only error codes (`bad_room_name`, `wrong_password`, `bad_password`) never reach a
 * socket. Nor is a new client event with its own ack, such as `history` (#33): no message
 * an older peer sends or reads changes, and a client and its server ship together.
 */
export const PROTOCOL_VERSION = 4;
