// English copy, the reference catalog: `fr` and `de` must have exactly these keys.
// Keys are nested like react-i18next namespaces; `{{name}}` marks an interpolation.
export const en = {
  app: {
    name: "Poker Planning",
    tagline: "Planning poker for teams",
    skipToContent: "Skip to content",
  },
  theme: {
    current: "Theme: {{mode}}",
    label: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  home: {
    title: "Estimate together, around one table",
    lede: "Everyone picks a card, the cards turn over together, and the team talks about the difference. No account needed.",
    createRoom: "Create a room",
    createRoomSoon: "Creating rooms arrives in the next version.",
  },
  room: {
    title: "Room {{code}}",
    codeLabel: "Room code",
    notOpenYet: "This room is not open yet: the table arrives in a later version.",
    backHome: "Back to the home page",
  },
  table: {
    seats: "People at the table",
    observers: "Observers",
    thinking: "Thinking",
    voted: "Voted",
    noVote: "No vote",
    seatThinking: "{{name}}, thinking",
    seatVoted: "{{name}}, voted",
    seatNoVote: "{{name}}, no vote",
    seatCard: "{{name}}, card {{card}}",
    seatCardWord: "{{name}}, {{card}}",
    votedSoFar: "{{count}}/{{total}} voted so far",
  },
  cards: {
    yourCards: "Your cards",
    unsure: "unsure",
    coffee: "needs a break",
    infinite: "too big to estimate",
  },
  dev: {
    tableTitle: "Table layout",
    tableLede:
      "A test bench for the table. Address parameters: n from 1 to 16, state lobby, voting or revealed, observers from 0 to 4.",
    hand: "Hand",
    miniCards: "Mini cards",
  },
  notFound: {
    title: "Page not found",
    body: "This address leads nowhere. Check the link or start again from the home page.",
  },
  common: {
    close: "Close",
    notifications: "Notifications",
  },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

/** The shape every catalog must match: the English keys, with any string as value. */
export type Messages = Widen<typeof en>;
