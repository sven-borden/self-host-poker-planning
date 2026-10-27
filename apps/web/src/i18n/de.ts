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
    loadFailed:
      "Diese Sprache konnte nicht geladen werden. Laden Sie die Seite neu und versuchen Sie es erneut.",
  },
  home: {
    title: "Gemeinsam schätzen, an einem Tisch",
    lede: "Alle wählen eine Karte, die Karten werden gemeinsam aufgedeckt, und das Team bespricht die Unterschiede. Kein Konto nötig.",
    createRoom: "Raum erstellen",
    howTitle: "So funktioniert es",
    step1Title: "Raum erstellen",
    step1Body:
      "Geben Sie ihm nach Wunsch einen Namen und wählen Sie ein Kartendeck. Sie werden sein Product Owner.",
    step2Title: "Link teilen",
    step2Body: "Ihr Team öffnet ihn und gibt einen Namen ein. Kein Konto, keine Installation.",
    step3Title: "Abstimmen",
    step3Body:
      "Alle wählen verdeckt eine Karte. Der Tisch zeigt, wer abgestimmt hat, aber nie, welche Karte.",
    step4Title: "Aufdecken",
    step4Body:
      "Die Karten werden gemeinsam umgedreht. Besprechen Sie die Unterschiede und spielen Sie die nächste Runde.",
  },
  createRoom: {
    lede: "Sie werden sein Product Owner. Teilen Sie den Link, und Ihr Team kommt dazu, ohne Konto.",
    nameLabel: "Raumname",
    optional: "Freiwillig",
    nameHint: "Alle mit dem Link sehen ihn. Höchstens {{max, number}} Zeichen.",
    deckLabel: "Kartendeck",
    submit: "Raum erstellen",
    creating: "Raum wird erstellt…",
    notAllowed:
      "Der Server hat diese Anfrage abgelehnt: Seine eingestellte Adresse ist nicht die, die Sie verwenden. Bitten Sie die Betreiberin oder den Betreiber, BASE_URL zu prüfen.",
  },
  decks: {
    fib: "Fibonacci",
    mfib: "Fibonacci, modifiziert",
    tshirt: "T-Shirt-Größen",
    pow2: "Zweierpotenzen",
    seq: "1 bis 10",
  },
  room: {
    title: "Raum {{code}}",
    codeLabel: "Raumcode",
    loading: "Raum wird geöffnet…",
    copyLink: "Link kopieren",
    linkCopied: "Link kopiert. Senden Sie ihn an Ihr Team.",
    copyFailed:
      "Ihr Browser hat das Kopieren nicht erlaubt. Markieren Sie den Link unten und kopieren Sie ihn.",
    linkLabel: "Raumlink",
    notFoundTitle: "Raum nicht gefunden",
    retry: "Erneut versuchen",
    statusConnecting: "Verbindung zum Raum wird hergestellt…",
    statusLive: "Verbunden",
    statusReconnecting: "Verbindung unterbrochen. Neuer Versuch…",
    people_one: "{{count, number}} Person im Raum",
    people_other: "{{count, number}} Personen im Raum",
    reload: "Neu laden",
    kicked: "Sie wurden aus diesem Raum entfernt.",
    offline:
      "Die Verbindung zum Server wurde unterbrochen. Laden Sie die Seite neu, um es erneut zu versuchen.",
    backHome: "Zurück zur Startseite",
    tableHeading: "Der Tisch",
    seatFree: "Ein Platz ist frei. Sie können jetzt beitreten.",
  },
  seat: {
    title: "Nehmen Sie Platz",
    lede: "Wählen Sie den Namen, den das Team am Tisch sieht.",
    nameLabel: "Ihr Name",
    nameHint: "Bis zu {{max, number}} Zeichen. Beim nächsten Mal ist er schon eingetragen.",
    roleLabel: "Ihre Rolle",
    voter: "Abstimmen",
    voterHint: "In jeder Runde eine Karte spielen",
    observer: "Beobachten",
    observerHint: "Zuschauen, ohne abzustimmen",
    submit: "Raum betreten",
    joining: "Raum wird betreten…",
    seatsFull:
      "Alle {{max, number}} Plätze sind besetzt. Wählen Sie „Beobachten“ oder warten Sie, bis jemand geht.",
    fullTitle: "Dieser Raum ist voll",
    fullBody:
      "In diesem Raum sind bereits {{max, number}} Personen. Sobald jemand geht, können Sie auf dieser Seite beitreten.",
  },
  you: {
    title: "Sie",
    roleVoter: "Am Tisch, Sie stimmen ab",
    roleObserver: "Sie beobachten, ohne abzustimmen",
    rename: "Namen ändern",
    save: "Speichern",
    saving: "Wird gespeichert…",
    cancel: "Abbrechen",
    toObserver: "Zum Beobachten wechseln",
    toVoter: "Zum Abstimmen wechseln",
    leave: "Raum verlassen",
    leaving: "Raum wird verlassen…",
    seatsFull: "Alle {{max, number}} Plätze sind besetzt. Versuchen Sie es, sobald jemand geht.",
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
    you: "Sie",
    owner: "Product Owner",
    away: "abwesend",
    ownerTag: "Product Owner",
    awayTag: "Abwesend",
  },
  round: {
    start: "Runde starten",
    next: "Nächste Runde",
    waiting: "Warten auf den PO",
    revealed: "Karten aufgedeckt",
  },
  hand: {
    hintVoting:
      "Wählen Sie eine Karte, um abzustimmen. Wählen Sie sie erneut, um Ihre Stimme zurückzunehmen.",
    hintLobby: "Ihre Karten werden spielbar, sobald der Product Owner die Runde startet.",
    hintRevealed:
      "Die Karten sind aufgedeckt. In dieser Runde lassen sich die Stimmen nicht mehr ändern.",
    youVoted: "Sie haben {{card}} gewählt.",
    retracted: "Stimme zurückgenommen.",
    ownerDoesNotVote: "Als Product Owner stimmen Sie in diesem Raum nicht ab.",
  },
  live: {
    joined: "{{name}} ist dem Raum beigetreten.",
    joinedMany_one: "{{count, number}} Person ist dem Raum beigetreten.",
    joinedMany_other: "{{count, number}} Personen sind dem Raum beigetreten.",
    left: "{{name}} hat den Raum verlassen.",
    leftMany_one: "{{count, number}} Person hat den Raum verlassen.",
    leftMany_other: "{{count, number}} Personen haben den Raum verlassen.",
    away: "{{name}} ist abwesend.",
    awayMany_one: "{{count, number}} Person ist abwesend.",
    awayMany_other: "{{count, number}} Personen sind abwesend.",
    back: "{{name}} ist zurück.",
    backMany_one: "{{count, number}} Person ist zurück.",
    backMany_other: "{{count, number}} Personen sind zurück.",
    voted: "{{name}} hat abgestimmt.",
    votedMany_one: "{{count, number}} Person hat abgestimmt.",
    votedMany_other: "{{count, number}} Personen haben abgestimmt.",
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
      "Ein Prüfstand für den Tisch. Adressparameter: n von 1 bis 16, state lobby, voting oder revealed, observers von 0 bis 4, away 0 oder 1.",
    hand: "Hand",
    miniCards: "Mini-Karten",
    average: "Durchschnitt der Zahlenkarten: {{value, number(maximumFractionDigits: 1)}}",
  },
  notFound: {
    title: "Seite nicht gefunden",
    body: "Diese Adresse führt nirgendwohin. Prüfen Sie den Link oder kehren Sie zur Startseite zurück.",
  },
  join: {
    title: "Mit Code beitreten",
    label: "Raumcode oder Link",
    hint: "Fügen Sie den Link ein, den Ihr Team geschickt hat, oder geben Sie den {{length, number}}-stelligen Code ein. Leerzeichen spielen keine Rolle.",
    submit: "Beitreten",
    empty: "Geben Sie einen Raumcode ein oder fügen Sie den Link zum Raum ein.",
    malformed:
      "Das ist kein Raumcode. Ein Code besteht aus {{length, number}} Buchstaben und Ziffern, ohne {{excluded}}. Prüfen Sie ihn oder fügen Sie den ganzen Link ein.",
    excluded: "0, O, I und l",
    otherHost: "Dieser Link gehört zu {{host}}.",
    openThere: "Dort öffnen",
  },
  roomGone: {
    lede: "Unter dieser Adresse gibt es keinen Raum. Möglicherweise ist Folgendes passiert:",
    typo: "Der Code oder Link wurde falsch abgetippt oder abgeschnitten. Vergleichen Sie ihn mit dem, den Sie erhalten haben.",
    expired_one:
      "Der Raum wurde gelöscht: Auf diesem Server wird ein Raum nach {{count, number}} Tag ohne Aktivität entfernt.",
    expired_other:
      "Der Raum wurde gelöscht: Auf diesem Server wird ein Raum nach {{count, number}} Tagen ohne Aktivität entfernt.",
    expiredUnknown:
      "Der Raum wurde gelöscht: Auf diesem Server wird ein Raum nach längerer Zeit ohne Aktivität entfernt.",
    tryAnother: "Anderen Code versuchen",
    createRoom: "Neuen Raum erstellen",
  },
  errorPage: {
    title: "Etwas ist schiefgelaufen",
    body: "Auf dieser Seite ist ein Fehler aufgetreten. Meist hilft es, die Seite neu zu laden. Passiert es wieder, beginnen Sie auf der Startseite neu.",
    reload: "Seite neu laden",
  },
  identity: {
    reconnecting: "Verbindung zum Server wird hergestellt…",
    cookiesBlocked:
      "Diese Website braucht Cookies, um Sie in einem Raum wiederzuerkennen. Erlauben Sie Cookies für diese Website und laden Sie die Seite dann neu.",
  },
  common: {
    network:
      "Der Server ist nicht erreichbar. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
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
    bad_name: "Ein Name hat {{min, number}} bis {{max, number}} Zeichen. Wählen Sie einen anderen.",
    bad_role: "Diese Rolle gibt es nicht. Wählen Sie „Abstimmen“ oder „Beobachten“.",
    room_full:
      "Dieser Raum ist voll. Bitten Sie jemanden, ihn zu verlassen, und versuchen Sie es dann erneut.",
    cannot_kick_self: "Sie können sich nicht selbst entfernen. Verlassen Sie stattdessen den Raum.",
    unknown_participant: "Diese Person ist nicht mehr im Raum.",
    bad_subject:
      "Das Thema der Runde ist ungültig. Prüfen Sie Titel oder Link und versuchen Sie es erneut.",
    no_round: "Es läuft keine Runde. Starten Sie zuerst eine Runde.",
    not_voter: "Beobachter stimmen nicht ab. Wechseln Sie zum Abstimmen, um eine Karte zu spielen.",
    bad_card: "Diese Karte gehört nicht zum Kartensatz des Raums. Wählen Sie eine andere.",
    round_revealed: "Die Karten sind bereits aufgedeckt. Stimmen lassen sich nicht mehr ändern.",
    not_voting: "In dieser Runde kann gerade nicht abgestimmt werden.",
    not_allowed: "Die Einstellungen dieses Raums erlauben das nicht.",
    not_revealed: "Decken Sie zuerst die Karten auf.",
    bad_seconds:
      "Ein Timer läuft {{min, number}} Sekunden bis {{max, number}} Minuten. Wählen Sie eine andere Dauer.",
    no_timer: "Es läuft kein Timer.",
    target_not_present:
      "Diese Person ist gerade nicht im Raum. Nur wer anwesend ist, kann Product Owner werden.",
    already_owner: "Sie sind bereits der Product Owner.",
    owner_present:
      "Der Product Owner ist noch da. Nach zwei Minuten Abwesenheit können Sie übernehmen.",
    bad_settings: "Diese Einstellungen sind ungültig. Prüfen Sie sie und versuchen Sie es erneut.",
    deck_empty: "Ein Kartensatz braucht mindestens eine Karte.",
    deck_too_many_cards:
      "Ein Kartensatz hat höchstens {{max, number}} Karten. Entfernen Sie einige und versuchen Sie es erneut.",
    card_empty: "Eine Karte darf nicht leer sein.",
    card_invalid:
      "Diese Karte enthält Zeichen, die sich nicht anzeigen lassen. Geben Sie sie erneut ein.",
    card_too_long: "Eine Kartenbeschriftung hat höchstens {{max, number}} Zeichen. Kürzen Sie sie.",
    card_duplicate: "Diese Karte ist bereits im Kartensatz.",
    card_special:
      "Die Sonderkarten (?, ☕, ∞) schalten Sie in den Raumeinstellungen ein, nicht im Kartensatz.",
    bad_payload:
      "Der Server konnte diese Anfrage nicht lesen. Laden Sie die Seite neu und versuchen Sie es erneut.",
    protocol_mismatch: "Eine neue Version der App ist verfügbar. Laden Sie die Seite neu.",
    bad_room_name:
      "Ein Raumname hat {{min, number}} bis {{max, number}} sichtbare Zeichen. Kürzen Sie ihn, oder lassen Sie das Feld leer.",
    room_not_found:
      "Diesen Raum gibt es nicht, oder er wurde nach langer Zeit ohne Nutzung gelöscht. Prüfen Sie den Link.",
    password_required: "Dieser Raum hat ein Passwort. Geben Sie es ein, um beizutreten.",
    unauthenticated: "Ihre Sitzung ist abgelaufen. Laden Sie die Seite neu, um fortzufahren.",
    rate_limited: "Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es dann erneut.",
    busy: "Der Raum war kurz beschäftigt. Versuchen Sie es erneut.",
    internal: "Auf dem Server ist etwas schiefgelaufen. Versuchen Sie es gleich noch einmal.",
    unknown: "Etwas ist schiefgelaufen. Versuchen Sie es erneut oder laden Sie die Seite neu.",
  },
};
