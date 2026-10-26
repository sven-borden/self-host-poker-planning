import type { Messages } from "./en.ts";

// German copy, addressed with "Sie" (OQ-2 default until #41).
export const de: Messages = {
  app: {
    name: "Poker Planning",
    tagline: "Planning Poker für Teams",
    skipToContent: "Zum Inhalt springen",
  },
  theme: {
    current: "Farbschema: {{mode}}",
    label: "Farbschema",
    light: "Hell",
    dark: "Dunkel",
    system: "System",
  },
  home: {
    title: "Gemeinsam schätzen, an einem Tisch",
    lede: "Alle wählen eine Karte, die Karten werden gemeinsam aufgedeckt, und das Team bespricht die Unterschiede. Kein Konto nötig.",
    createRoom: "Raum erstellen",
    createRoomSoon: "Das Erstellen von Räumen folgt in der nächsten Version.",
  },
  room: {
    title: "Raum {{code}}",
    codeLabel: "Raumcode",
    notOpenYet: "Dieser Raum ist noch nicht geöffnet: Der Tisch folgt in einer späteren Version.",
    backHome: "Zurück zur Startseite",
  },
  table: {
    seats: "Personen am Tisch",
    observers: "Beobachter",
    thinking: "Überlegt",
    voted: "Hat abgestimmt",
    noVote: "Keine Stimme",
    seatThinking: "{{name}}, überlegt",
    seatVoted: "{{name}}, hat abgestimmt",
    seatNoVote: "{{name}}, keine Stimme",
    seatCard: "{{name}}, Karte {{card}}",
    seatCardWord: "{{name}}, {{card}}",
    votedSoFar: "{{count}}/{{total}} haben bisher abgestimmt",
  },
  cards: {
    yourCards: "Ihre Karten",
    unsure: "unsicher",
    coffee: "braucht eine Pause",
    infinite: "zu groß zum Schätzen",
  },
  dev: {
    tableTitle: "Tischanordnung",
    tableLede:
      "Ein Prüfstand für den Tisch. Adressparameter: n von 1 bis 16, state lobby, voting oder revealed, observers von 0 bis 4.",
    hand: "Hand",
    miniCards: "Mini-Karten",
  },
  notFound: {
    title: "Seite nicht gefunden",
    body: "Diese Adresse führt nirgendwohin. Prüfen Sie den Link oder beginnen Sie auf der Startseite.",
  },
  common: {
    close: "Schließen",
    notifications: "Benachrichtigungen",
  },
};
