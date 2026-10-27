/**
 * Version of the wire protocol between the web app and the server. Bump it on any
 * breaking change to a command, snapshot or event, so an old client can be told to reload.
 * 2: the `busy` ack code (#15).
 */
export const PROTOCOL_VERSION = 2;
