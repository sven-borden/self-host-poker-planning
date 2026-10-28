/**
 * The join form's password block, a lazy chunk (#31). The room page calls this as soon as
 * the room's header says it has a password, so the field is there when the form asks.
 */
export const loadJoinPassword = () => import("./join-password.tsx");
