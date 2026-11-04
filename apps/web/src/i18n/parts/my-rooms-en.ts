// The words of “My rooms” (#49), in English. A part of the catalog that loads with its panel, not
// with the page (copy-parts.ts): the keys keep their place, so `t` reads them as it reads the rest.
export const copy = {
  myRooms: {
    intro:
      "The rooms you own, and the rooms where you hold a seat now. Leave a room or get removed from it, and it goes from this list.",
    retention_one:
      "Rooms you own stay until you delete them. Any other room on this list can go after {{count, number}} day without activity.",
    retention_other:
      "Rooms you own stay until you delete them. Any other room on this list can go after {{count, number}} days without activity.",
    signedOut:
      "Sign in to see the rooms you own and the rooms where you hold a seat. What you did as a guest comes with you.",
    loading: "Loading your rooms…",
    moving: "Some of your rooms are still on their way to your account. Try again in a moment.",
    emptyTitle: "No rooms yet",
    emptyBody: "Rooms you create or join while signed in show up here.",
    owned: "You own this room",
    joined: "You hold a seat",
    claimed: "You are the product owner",
    claimedWhy:
      "The role lets you run this room and rename it. Deleting it stays with the person it belongs to: taking over the role, or being passed it, does not carry that right.",
    noKeeperWhy_one:
      "The role lets you run this room and rename it. Nobody can delete it: that right went with the account that held it. It goes after {{count, number}} day without activity.",
    noKeeperWhy_other:
      "The role lets you run this room and rename it. Nobody can delete it: that right went with the account that held it. It goes after {{count, number}} days without activity.",
    kept: "Your room, with another product owner",
    keptWhy:
      "Someone else took over as product owner. Get the role back in the room, and you can delete it.",
    signInAgain:
      "Some of your rooms ask for a recent sign-in. Sign out, then sign in again to see them.",
    rounds_one: "{{count, number}} round",
    rounds_other: "{{count, number}} rounds",
    showMore: "Show more rooms",
    cancel: "Cancel",
    rename: "Rename",
    renameNamed: "Rename {{name}}",
    renameTitle: "Rename this room",
    nameLabel: "Room name",
    save: "Save",
    renamed: "Room renamed.",
    delete: "Delete",
    deleteNamed: "Delete {{name}}",
    deleteTitle: "Delete {{name}}?",
    deleteBody:
      "This removes the room for everyone: its rounds, its history, its queue and who may enter it. It cannot be undone.",
    deleteLive: "Anyone in the room right now sees at once that it is gone.",
    deleteConfirm: "Delete this room",
    deleted: "Room deleted.",
    leave: "Leave this room",
    leaveNamed: "Leave this room: {{name}}",
    leaveTitle: "Leave {{name}}?",
    leaveBody:
      "Your seat goes, and the room goes from this list. The room’s link lets you join again.",
    leaveKept: "Your seat goes. The room stays on this list, as it is still yours.",
    left: "You left the room.",
    gone: "That room is no longer there.",
  },
} as const;
