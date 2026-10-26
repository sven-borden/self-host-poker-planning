import type { Catalog } from "./en.ts";

// German copy, addressed with "Sie" (OQ-2 default until #41). Loaded on demand: see
// i18n.ts.
export const de: Catalog = {
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
  language: {
    current: "Sprache: {{language}}",
    label: "Sprache",
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
    votedSoFar_one: "{{count, number}}/{{total, number}} hat bisher abgestimmt",
    votedSoFar_other: "{{count, number}}/{{total, number}} haben bisher abgestimmt",
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
    average: "Durchschnitt der Zahlenkarten: {{value, number(maximumFractionDigits: 1)}}",
  },
  notFound: {
    title: "Seite nicht gefunden",
    body: "Diese Adresse führt nirgendwohin. Prüfen Sie den Link oder beginnen Sie auf der Startseite.",
  },
  common: {
    close: "Schließen",
    notifications: "Benachrichtigungen",
  },
  errors: {
    bad_command:
      "Die App hat etwas gesendet, das der Server nicht versteht. Laden Sie die Seite neu und versuchen Sie es erneut.",
    not_participant:
      "Sie sind nicht mehr in diesem Raum. Laden Sie die Seite neu, um wieder beizutreten.",
    not_owner: "Nur der Product Owner kann das tun.",
    already_joined: "Sie sind bereits in diesem Raum.",
    bad_name: "Dieser Name kann nicht verwendet werden. Wählen Sie einen anderen.",
    bad_role: "Diese Rolle gibt es nicht. Wählen Sie Abstimmen oder Beobachten.",
    room_full:
      "Dieser Raum ist voll. Bitten Sie jemanden, ihn zu verlassen, und versuchen Sie es dann erneut.",
    cannot_kick_self: "Sie können sich nicht selbst entfernen. Verlassen Sie stattdessen den Raum.",
    unknown_participant: "Diese Person ist nicht mehr im Raum.",
    bad_subject:
      "Das Thema der Runde ist ungültig. Prüfen Sie Titel oder Link und versuchen Sie es erneut.",
    no_round: "Es läuft keine Runde. Starten Sie zuerst eine Runde.",
    not_voter: "Beobachter stimmen nicht ab. Wechseln Sie zum Abstimmen, um eine Karte zu spielen.",
    bad_card: "Diese Karte gehört nicht zum Kartensatz des Raums. Wählen Sie eine andere.",
    round_revealed: "Die Karten sind bereits aufgedeckt, Stimmen lassen sich nicht mehr ändern.",
    not_voting: "In dieser Runde kann gerade nicht abgestimmt werden.",
    not_allowed: "Die Einstellungen dieses Raums erlauben das nicht.",
    not_revealed: "Decken Sie zuerst die Karten auf.",
    bad_seconds: "Diese Timerdauer ist nicht erlaubt. Wählen Sie eine andere.",
    no_timer: "Es läuft kein Timer.",
    target_not_present:
      "Diese Person ist gerade nicht im Raum. Nur wer anwesend ist, kann Product Owner werden.",
    already_owner: "Sie sind bereits der Product Owner.",
    owner_present:
      "Der Product Owner ist noch da. Sie können übernehmen, sobald er zwei Minuten abwesend war.",
    bad_settings: "Diese Einstellungen sind ungültig. Prüfen Sie sie und versuchen Sie es erneut.",
    deck_empty: "Ein Kartensatz braucht mindestens eine Karte.",
    deck_too_many_cards:
      "Dieser Kartensatz hat zu viele Karten. Entfernen Sie einige und versuchen Sie es erneut.",
    card_empty: "Eine Karte darf nicht leer sein.",
    card_invalid:
      "Diese Karte enthält Zeichen, die sich nicht anzeigen lassen. Geben Sie sie erneut ein.",
    card_too_long: "Diese Kartenbeschriftung ist zu lang. Kürzen Sie sie.",
    card_duplicate: "Diese Karte ist bereits im Kartensatz.",
    card_special:
      "Die Sonderkarten (?, ☕, ∞) schalten Sie in den Raumeinstellungen ein, nicht im Kartensatz.",
    bad_payload:
      "Der Server konnte diese Anfrage nicht lesen. Laden Sie die Seite neu und versuchen Sie es erneut.",
    protocol_mismatch: "Eine neue Version der App ist verfügbar. Laden Sie die Seite neu.",
    room_not_found:
      "Diesen Raum gibt es nicht, oder er wurde nach langer Zeit ohne Nutzung gelöscht. Prüfen Sie den Link.",
    password_required: "Dieser Raum hat ein Passwort. Geben Sie es ein, um beizutreten.",
    unauthenticated: "Ihre Sitzung ist abgelaufen. Laden Sie die Seite neu, um fortzufahren.",
    rate_limited: "Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es dann erneut.",
    internal: "Auf dem Server ist etwas schiefgelaufen. Versuchen Sie es gleich noch einmal.",
    unknown: "Etwas ist schiefgelaufen. Versuchen Sie es erneut oder laden Sie die Seite neu.",
  },
};
