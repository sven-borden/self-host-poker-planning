import type { Catalog } from "./en.ts";

// German copy. The reader is always "Sie" (OQ-2, ADR-012), and the words are those of
// docs/08-glossary.md. Loaded on demand: see i18n.ts.
export const de: Catalog = {
  app: {
    name: "Poker Planning",
    tagline: "Planning Poker für Teams",
    description: "Selbst gehostetes Planning Poker für Teams.",
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
    optional: "Optional",
    nameHint: "Alle mit dem Link sehen ihn. Höchstens {{max, number}} Zeichen.",
    deckLabel: "Kartendeck",
    submit: "Raum erstellen",
    creating: "Raum wird erstellt…",
    notAllowed:
      "Der Server hat diese Anfrage abgelehnt: Seine eingestellte Adresse ist nicht die, die Sie verwenden. Bitten Sie die Person, die diesen Server betreibt, BASE_URL zu prüfen.",
  },
  decks: {
    fib: "Fibonacci",
    mfib: "Modifiziertes Fibonacci",
    tshirt: "T-Shirt-Größen",
    pow2: "Zweierpotenzen",
    seq: "1 bis 10",
    custom: "Eigenes Kartendeck",
    named: "„{{deck}}“",
    // After „mit“ and „zu“, the only places a deck is named inside a sentence: dative.
    customInSentence: "einem eigenen Kartendeck",
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
    kicked: "Der Product Owner hat Sie aus diesem Raum entfernt.",
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
    roleNotVoting: "Am Tisch, ohne abzustimmen",
    roleObserver: "Sie beobachten, ohne abzustimmen",
    rename: "Namen ändern",
    save: "Speichern",
    saving: "Wird gespeichert…",
    cancel: "Abbrechen",
    toObserver: "Zum Beobachten wechseln",
    toVoter: "Zum Abstimmen wechseln",
    leave: "Raum verlassen",
    leaving: "Raum wird verlassen…",
    seatsFull:
      "Alle {{max, number}} Plätze sind besetzt. Versuchen Sie es erneut, sobald jemand geht.",
  },
  avatar: {
    label: "Ihr Avatar",
    hint: "Er ersetzt Ihre Initialen am Tisch.",
    choose: "Avatar wählen",
    change: "Avatar ändern",
    initials: "Initialen",
    bat: "Fledermaus",
    bear: "Bär",
    cat: "Katze",
    chick: "Küken",
    cow: "Kuh",
    deer: "Hirsch",
    dog: "Hund",
    fox: "Fuchs",
    frog: "Frosch",
    hedgehog: "Igel",
    koala: "Koala",
    lion: "Löwe",
    monkey: "Affe",
    mouse: "Maus",
    otter: "Otter",
    owl: "Eule",
    panda: "Panda",
    penguin: "Pinguin",
    pig: "Schwein",
    rabbit: "Hase",
    raccoon: "Waschbär",
    seal: "Robbe",
    sheep: "Schaf",
    tiger: "Tiger",
  },
  settings: {
    openOwner: "Raumeinstellungen",
    openOthers: "Raumregeln",
    loadFailed:
      "Die Einstellungen ließen sich nicht öffnen. Laden Sie die Seite neu und versuchen Sie es noch einmal.",
    timerCustomHint: "Von 5 Sekunden bis 60 Minuten: 90 oder 1:30.",
    timerCustomBad:
      "Geben Sie 5 Sekunden bis 60 Minuten ein, in Sekunden (90) oder in Minuten und Sekunden (1:30).",
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
    nameNumbered: "{{name}} ({{number, number}})",
    votedSoFar_one: "{{count, number}}/{{total, number}} hat abgestimmt",
    votedSoFar_other: "{{count, number}}/{{total, number}} haben abgestimmt",
    you: "Sie",
    owner: "Product Owner",
    away: "abwesend",
    ownerTag: "Product Owner",
    awayTag: "Abwesend",
    lowest: "niedrigste Karte",
    highest: "höchste Karte",
    lowestTag: "Niedrigste Karte",
    highestTag: "Höchste Karte",
    changed: "nach dem Aufdecken geändert",
    changedTag: "Nach dem Aufdecken geändert",
    changedChip: "geändert",
  },
  round: {
    start: "Runde starten",
    next: "Nächste Runde",
    revote: "Neu abstimmen",
    waiting: "Warten auf den PO",
    revealed: "Karten aufgedeckt",
    reveal: "Karten aufdecken",
    revealKey: "Taste R, solange der Fokus auf dem Tisch oder Ihren Karten liegt",
    revealOwnerOnly: "Nicht aufgedeckt: Nur der Product Owner kann die Karten jetzt aufdecken.",
    revealWaits:
      "Warten Sie auf zwei Karten: In einer anonymen Runde zeigt eine einzelne Karte, von wem sie ist.",
    number: "Runde {{round, number}}",
    subjectLabel: "Thema der nächsten Runde",
    subjectHint:
      "Für Runde {{round, number}} leer lassen, einen Titel eingeben oder den Link zum Ticket einfügen.",
    subjectHintVoting: "Runde {{round, number}} beginnt nach dem Aufdecken mit diesem Thema.",
    opensInNewTab: "(öffnet in einem neuen Tab)",
    anonymous: "Anonym",
    anonymousHint: "Die Karten werden ohne Namen gezeigt.",
    anonymousSpoken: "Anonyme Runde: Die Karten werden ohne Namen gezeigt.",
    titleTooLong: "Ein Titel darf höchstens {{max, number}} Zeichen lang sein.",
    linkTooLong: "Ein Link darf höchstens {{max, number}} Zeichen lang sein.",
    badLink: "Nur http- und https-Links sind möglich, ohne Benutzername und Passwort.",
  },
  results: {
    title: "Ergebnisse",
    average: "Durchschnitt",
    median: "Median",
    agreement: "Einigkeit",
    spread: "Spanne",
    mostVoted: "Meiste Stimmen",
    noValue: "kein Wert",
    spreadRange: "{{low}} bis {{high}}",
    distribution: "Stimmen pro Karte",
    cardVotes_one: "{{card}}: {{count, number}} Stimme",
    cardVotes_other: "{{card}}: {{count, number}} Stimmen",
    notCounted: "Nicht gezählt",
    notCountedNote: "Sonderkarten zählen nicht mit.",
    extremes: "Niedrigste und höchste Karte",
    lowest: "Niedrigste",
    highest: "Höchste",
    lowestNames: "Niedrigste Karte {{card}}: {{names}}",
    highestNames: "Höchste Karte {{card}}: {{names}}",
    consensus: "Konsens",
    consensusOn: "Konsens bei {{card}}.",
    agreementShort: "Einigkeit {{agreement, number(style: percent; maximumFractionDigits: 0)}}",
    tie: "Gleichstand",
    moreCards: "+{{count, number}}",
    cardsTie_one: "{{count, number}} Karte gleichauf",
    cardsTie_other: "{{count, number}} Karten gleichauf",
    suggestedAgreement:
      "Vorschlag: {{card}}. Einigkeit: {{agreement, number(style: percent; maximumFractionDigits: 0)}}.",
    mostVotedAgreement:
      "Meiste Stimmen: {{card}}. Einigkeit: {{agreement, number(style: percent; maximumFractionDigits: 0)}}.",
    tieAgreement:
      "Gleichstand zwischen {{cards}}. Einigkeit: {{agreement, number(style: percent; maximumFractionDigits: 0)}}.",
    nothing: "Nichts zu zählen.",
    cards: "Gespielte Karten",
    offTable: "Nicht am Tisch",
    someone: "Jemand, der gegangen ist",
  },
  final: {
    label: "Endgültige Schätzung",
    short: "Endgül\u{ad}tig",
    record: "{{card}} festhalten",
    recordNothing: "Festhalten",
    recorded: "Festgehalten",
    changedSince: "Stimmen haben sich geändert, seit Sie {{card}} festgehalten haben.",
    pick: "Wählen Sie die endgültige Schätzung und halten Sie sie fest.",
    suggested: "{{card}}, vorgeschlagen",
    tied: "{{card}}, gleichauf",
    centre: "Endgültige Schätzung: {{card}}.",
  },
  timer: {
    seconds_one: "{{count, number}} Sekunde",
    seconds_other: "{{count, number}} Sekunden",
    minutes_one: "{{count, number}} Minute",
    minutes_other: "{{count, number}} Minuten",
    minutesSeconds: "{{minutes}} {{seconds}}",
    shortSeconds: "{{n, number}} s",
    shortMinutes: "{{n, number}} min",
    button: "Timer",
    buttonRunning: "Timer läuft",
    buttonUp: "Timer, Zeit ist um",
    menu: "Timer",
    start: "Timer starten",
    restart: "Neu starten",
    add: "+30 s",
    addSpoken: "30 Sekunden hinzufügen",
    stop: "Stoppen",
    stopSpoken: "Timer stoppen",
    customLabel: "Dauer",
    customStart: "Starten",
    left: "Verbleibende Zeit: {{time}}",
    up: "Zeit ist um",
  },
  hand: {
    hintVoting:
      "Wählen Sie eine Karte, um abzustimmen. Wählen Sie sie erneut, um Ihre Stimme zurückzunehmen.",
    hintLobby: "Ihre Karten werden spielbar, sobald der Product Owner die Runde startet.",
    hintLobbyOwner: "Starten Sie die Runde, um Ihre Karten zu spielen.",
    hintRevealed:
      "Die Karten sind aufgedeckt. In dieser Runde lassen sich die Stimmen nicht mehr ändern.",
    youVoted: "Ihre Stimme: {{card}}.",
    hintChange: "Sie können Ihre Karte noch ändern.",
    youChanged: "Sie haben Ihre Karte geändert: {{card}}.",
    retracted: "Stimme zurückgenommen.",
    ownerDoesNotVote: "Als Product Owner stimmen Sie in diesem Raum nicht ab.",
  },
  po: {
    makeOwner: "Zum Product Owner machen",
    remove: "Aus dem Raum entfernen",
    handOverVoter: "Die Rolle des Product Owners an {{name}} übergeben? Sie stimmen danach mit ab.",
    handOverStayVoter:
      "Die Rolle des Product Owners an {{name}} übergeben? Sie stimmen weiter mit ab.",
    handOverObserver: "Die Rolle des Product Owners an {{name}} übergeben? Sie beobachten weiter.",
    handOverNoVote:
      "Der Product Owner stimmt in diesem Raum nicht ab, also stimmt {{name}} danach nicht mehr ab.",
    handOver: "Übergeben",
    handingOver: "Wird übergeben…",
    removeQuestion:
      "{{name}} aus dem Raum entfernen? Über den Link kann die Person wieder beitreten.",
    removeConfirm: "Entfernen",
    removing: "Wird entfernt…",
    cancel: "Abbrechen",
    targetAway: "{{name}} ist abwesend.",
  },
  offline: {
    title: "Poker Planning ist nicht erreichbar",
    body: "Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
    retry: "Erneut versuchen",
  },
  claim: {
    away: "{{name}}, der Product Owner, ist abwesend.",
    gone: "Der Product Owner hat den Raum verlassen.",
    button: "Rolle des Product Owners übernehmen",
    claiming: "Wird übernommen…",
    notYet:
      "Noch nicht: Der Product Owner ist zurück oder seit weniger als {{minutes, number}} Minuten abwesend.",
  },
  live: {
    joined: "{{name}} ist dem Raum beigetreten.",
    joinedMany_one: "{{count, number}} Person ist dem Raum beigetreten.",
    joinedMany_other: "{{count, number}} Personen sind dem Raum beigetreten.",
    left: "{{name}} hat den Raum verlassen.",
    leftMany_one: "{{count, number}} Person hat den Raum verlassen.",
    leftMany_other: "{{count, number}} Personen haben den Raum verlassen.",
    removed: "Der Product Owner hat {{name}} aus dem Raum entfernt.",
    removedMany_one: "Der Product Owner hat {{count, number}} Person aus dem Raum entfernt.",
    removedMany_other: "Der Product Owner hat {{count, number}} Personen aus dem Raum entfernt.",
    ownerHandedOver: "{{from}} hat die Rolle des Product Owners an {{to}} übergeben.",
    ownerClaimed: "{{name}} hat die Rolle des Product Owners übernommen.",
    ownerNow: "{{name}} ist jetzt der Product Owner.",
    away: "{{name}} ist abwesend.",
    awayMany_one: "{{count, number}} Person ist abwesend.",
    awayMany_other: "{{count, number}} Personen sind abwesend.",
    back: "{{name}} ist zurück.",
    backMany_one: "{{count, number}} Person ist zurück.",
    backMany_other: "{{count, number}} Personen sind zurück.",
    voted: "{{name}} hat abgestimmt.",
    votedMany_one: "{{count, number}} Person hat abgestimmt.",
    votedMany_other: "{{count, number}} Personen haben abgestimmt.",
    roundStarted: "Die Abstimmung hat begonnen: {{subject}}.",
    roundStartedAnonymous: "Die Abstimmung hat begonnen: {{subject}}, anonym.",
    revealed: "Die Karten sind aufgedeckt.",
    revealedBy: "{{name}} hat die Karten aufgedeckt.",
    finalRecorded: "Der Product Owner hat {{card}} als endgültige Schätzung festgehalten.",
    finalChanged: "Der Product Owner hat die endgültige Schätzung auf {{card}} geändert.",
    revote: "Der Product Owner hat eine neue Abstimmung zum selben Thema gestartet.",
    revoteAnonymous:
      "Der Product Owner hat eine neue, anonyme Abstimmung zum selben Thema gestartet.",
    anonymousOn: "Ab Runde {{round, number}} wird anonym abgestimmt.",
    anonymousOff: "Ab Runde {{round, number}} wird wieder mit Namen abgestimmt.",
    autoRevealOn: "Die Karten werden jetzt aufgedeckt, sobald alle abgestimmt haben.",
    autoRevealOff: "Die Karten warten jetzt auf das Aufdecken, auch wenn alle abgestimmt haben.",
    autoAdvanceOn:
      "Der nächste Eintrag startet jetzt automatisch, sobald eine Schätzung festgehalten ist.",
    autoAdvanceOff: "Der nächste Eintrag startet nicht mehr automatisch.",
    restrictionChanged: "Der Product Owner hat geändert, wer diesem Raum beitreten kann.",
    queueAdded_one:
      "{{count, number}} Eintrag zur Warteschlange hinzugefügt. Als Nächstes: {{item}}.",
    queueAdded_other:
      "{{count, number}} Einträge zur Warteschlange hinzugefügt. Als Nächstes: {{item}}.",
    queueAddedPlain_one: "{{count, number}} Eintrag zur Warteschlange hinzugefügt.",
    queueAddedPlain_other: "{{count, number}} Einträge zur Warteschlange hinzugefügt.",
    advanceSoon: "Als Nächstes, in {{seconds, number}} Sekunden: {{item}}.",
    advanceHeld: "Der Raum bleibt bei dieser Runde.",
    roomRenamed: "Der Raum heißt jetzt {{name}}.",
    poVotesOn: "Der Product Owner stimmt jetzt mit ab.",
    poVotesOff: "Der Product Owner stimmt nicht mehr mit ab.",
    observersCountOn: "Beobachter belegen jetzt einen der {{max, number}} Plätze.",
    observersCountOff: "Beobachter belegen keinen der {{max, number}} Plätze mehr.",
    deckChanged: "Der Product Owner wechselt ab der nächsten Runde zu {{deck}}.",
    specialsChanged: "Der Product Owner ändert die Sonderkarten ab der nächsten Runde.",
    deckRestarted: "Der Product Owner hat Runde {{round, number}} mit {{deck}} neu gestartet.",
    specialsRestarted:
      "Der Product Owner hat Runde {{round, number}} mit neuen Sonderkarten neu gestartet.",
    voteAgain: "Stimmen Sie erneut ab.",
    deckNow: "Der Product Owner hat zu {{deck}} gewechselt.",
    specialsNow: "Der Product Owner hat die Sonderkarten geändert.",
    timerChanged: "Der Product Owner hat den Timer geändert.",
    timerStarted: "Timer gestartet: {{duration}}.",
    timerExtended: "{{duration}} mehr.",
    timerExtendedSome: "Mehr Zeit.",
    timerStopped: "Timer gestoppt.",
    timeUp: "Die Zeit ist um.",
    tenLeft: "Noch {{n, number}} Sekunden.",
    revealAnyone: "Alle, die abstimmen, können die Karten jetzt aufdecken.",
    revealOwner: "Nur der Product Owner kann die Karten jetzt aufdecken.",
    changeAfterRevealOn: "Stimmen können jetzt nach dem Aufdecken geändert werden.",
    changeAfterRevealOff: "Stimmen können nach dem Aufdecken nicht mehr geändert werden.",
    changed: "{{name}} hat die Karte geändert: {{card}}.",
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
    deleted: "Der Product Owner des Raums hat ihn gelöscht.",
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
  signIn: {
    google: "Mit Google anmelden",
    microsoft: "Mit Microsoft anmelden",
    hint: "Optional: Ihr Name begleitet Sie auf Ihre anderen Geräte.",
    signedInAs: "Angemeldet als",
    signedInWith: "Angemeldet mit {{provider}}",
    signOut: "Abmelden",
    signingOut: "Wird abgemeldet…",
    errors: {
      cancelled: "Anmeldung abgebrochen. Sie können ohne Konto weitermachen.",
      accountExists:
        "Zu dieser E-Mail-Adresse gibt es schon ein Konto mit einer anderen Anmeldung. Melden Sie sich auf diesem Weg an.",
      noEmail:
        "Ihr Konto hat keine E-Mail-Adresse übermittelt, deshalb konnte die Anmeldung nicht abgeschlossen werden.",
      tenantNotAllowed:
        "Diese Website akzeptiert dieses Microsoft-Konto nicht. Versuchen Sie es mit einem anderen oder machen Sie ohne Konto weiter.",
      rateLimited:
        "Zu viele Anmeldeversuche. Warten Sie eine Minute und versuchen Sie es dann erneut.",
      failed:
        "Die Anmeldung wurde nicht abgeschlossen. Versuchen Sie es erneut oder machen Sie ohne Konto weiter.",
      stillMoving:
        "Sie sind angemeldet. Einige Ihrer Räume werden noch in Ihr Konto übertragen. Öffnen Sie sie gleich noch einmal.",
      accountGoing: "Ihr Konto wird gelöscht. Danach legt eine neue Anmeldung ein neues Konto an.",
    },
  },
  account: {
    title: "Konto",
  },
  restriction: {
    title: "Dieser Raum ist bestimmten Konten vorbehalten",
    needsDomains: "Melden Sie sich zum Beitreten mit einem Google-Konto auf {{domains}} an.",
    needsOrganisation:
      "Melden Sie sich zum Beitreten mit einem Microsoft-Konto Ihrer Organisation an.",
    needsBoth:
      "Melden Sie sich zum Beitreten mit einem Google-Konto auf {{domains}} oder einem Microsoft-Konto Ihrer Organisation an.",
    guest: "Gäste können diesem Raum nicht beitreten. Melden Sie sich an, um fortzufahren.",
    otherDomain:
      "Ihr Google-Konto liegt nicht auf einer dieser Domains, oder Google hat seine Adresse nicht bestätigt. Melden Sie sich ab, um ein anderes Konto zu verwenden.",
    otherOrganisation:
      "Ihr Microsoft-Konto gehört zu einer anderen Organisation. Melden Sie sich ab, um ein anderes Konto zu verwenden.",
    microsoftDomain:
      "Eine Microsoft-Anmeldung zählt nie für eine E-Mail-Domain, weil sie die Adresse nicht belegt. Melden Sie sich ab, um ein Google-Konto zu verwenden, oder bitten Sie den Product Owner, Ihre Organisation hinzuzufügen.",
    needsMicrosoft:
      "Dieser Raum lässt Microsoft-Konten Ihrer Organisation zu. Melden Sie sich ab, um eines zu verwenden.",
    otherAccount:
      "Mit diesem Konto können Sie diesem Raum nicht beitreten. Melden Sie sich ab, um ein anderes zu verwenden.",
    sessionTooOld:
      "Ihre Anmeldung ist älter als {{days, number}} Tage. Dieser Raum verlangt eine aktuelle Anmeldung, denn nur so kann Ihr Anbieter bestätigen, dass Sie noch dazugehören. Melden Sie sich ab und dann wieder an.",
    unavailable:
      "Dieser Server bietet die Anmeldung, die dieser Raum verlangt, nicht mehr an. Darum kann vorerst niemand beitreten. Bitten Sie den Product Owner, die Regel des Raums zu ändern.",
  },
  myRooms: {
    title: "Meine Räume",
    lastActive: "Zuletzt aktiv {{when}}",
  },
  password: {
    label: "Passwort",
    show: "Passwort anzeigen",
    roomHas: "Dieser Raum hat ein Passwort.",
    linkCopied: "Link kopiert. Zum Beitreten braucht es auch das Passwort.",
    changed: "Der Product Owner hat das Passwort geändert.",
    missing: "Geben Sie das Passwort des Raums ein.",
    busy: "Gerade treten viele gleichzeitig bei. Versuchen Sie es gleich noch einmal.",
    tooMany_one: "Zu viele Versuche. Versuchen Sie es in {{count, number}} Minute erneut.",
    tooMany_other: "Zu viele Versuche. Versuchen Sie es in {{count, number}} Minuten erneut.",
    liveSet: "Der Product Owner hat ein Passwort für diesen Raum festgelegt.",
    liveChanged: "Der Product Owner hat das Passwort des Raums geändert.",
    liveRemoved: "Der Product Owner hat das Passwort des Raums entfernt.",
  },
  history: {
    open: "Verlauf",
    loadFailed:
      "Der Verlauf ließ sich nicht öffnen. Laden Sie die Seite neu und versuchen Sie es noch einmal.",
    failed: "Die Runden ließen sich nicht laden. Versuchen Sie es noch einmal.",
  },
  queue: {
    open: "Warteschlange",
    count_one: "{{count, number}} Eintrag",
    count_other: "{{count, number}} Einträge",
    overflow_one:
      "{{count, number}} Eintrag passte nicht mehr: Eine Warteschlange fasst höchstens {{max, number}}, bei langen Einträgen weniger.",
    overflow_other:
      "{{count, number}} Einträge passten nicht mehr: Eine Warteschlange fasst höchstens {{max, number}}, bei langen Einträgen weniger.",
    failed: "Die Warteschlange konnte nicht geladen werden.",
    loadFailed:
      "Die Warteschlange konnte nicht geöffnet werden. Laden Sie die Seite neu und versuchen Sie es erneut.",
    nextItem: "Nächster Eintrag",
    next: "Als Nächstes: {{item}}",
    nextIn: "Als Nächstes: {{item}}, in {{seconds, number}} s",
    stay: "Bei dieser Runde bleiben",
    subjectHint:
      "Leer startet der nächste Eintrag: {{item}}. Ein eingegebenes Thema geht vor, und die Warteschlange wartet.",
  },
  connector: {
    loadFailed:
      "Der Teil dieser Seite für {{system}} konnte nicht geladen werden. Der Raum funktioniert weiter: Laden Sie die Seite neu, um diesen Teil wieder zu sehen.",
    result: {
      connected: "{{system}} ist verbunden.",
      cancelled: "Nichts wurde verbunden: Sie sind bei {{system}} zurückgegangen.",
      lost: "{{system}} wurde nicht verbunden: Dieser Link ist abgelaufen oder wurde schon benutzt. Gehen Sie zurück in Ihren Raum und verbinden Sie es dort über die Warteschlange.",
    },
    write: {
      waiting:
        "{{item}}: {{card}} wurde nicht auf dieser Seite festgehalten, und vielleicht hat es jemand anderes getan. Ein Klick schreibt es mit Ihrem Konto in {{system}}.",
      writing: "{{card}} wird in {{item}} bei {{system}} geschrieben…",
      written: "{{item}}: {{card}} steht in {{system}}.",
      failed: "{{item}}: {{card}} ist nicht bei {{system}} angekommen.",
      retry: "Erneut versuchen",
      dismiss: "Ausblenden",
      history: "In {{system}} schreiben",
    },
    azure: {
      errors: {
        connector_no_site: "Wählen Sie zuerst in der Warteschlange ein Azure-DevOps-Projekt.",
        connector_bad_site: "Dieses Projekt steht nicht mehr auf Ihrer Liste.",
        connector_bad_field: "Dieses Feld ist kein Zahlenfeld dieses Arbeitselementtyps.",
        connector_other_site:
          "Dieser Eintrag gehört zu einer anderen Azure-DevOps-Organisation als der, mit der Sie verbunden sind.",
        connector_no_source: "Dieser Eintrag stammt nicht aus Azure DevOps.",
        connector_field_refused:
          "Azure DevOps hat diese Zahl bei diesem Eintrag abgelehnt: Eine Regel seines Typs verbietet sie vielleicht.",
      },
    },
    errors: {
      connector_sign_in: "Melden Sie sich mit einem Konto an, um {{system}} zu nutzen.",
      connector_not_connected: "Verbinden Sie zuerst {{system}} in der Warteschlange.",
      connector_bad_organization:
        "Das ist kein Organisationsname. Geben Sie nur den Namen an, ohne Adresse darum herum.",
      connector_bad_token:
        "{{system}} hat dieses Token nicht angenommen. Es ist vielleicht falsch eingegeben, abgelaufen oder für eine andere Organisation erstellt.",
      connector_no_access:
        "{{system}} hat dieses Token nicht in diese Organisation gelassen. Das Token ist vielleicht falsch, abgelaufen oder ohne den nötigen Bereich, oder sein Konto ist kein Mitglied. Prüfen Sie den Namen und das Token.",
      connector_no_projects:
        "Dieses Token funktioniert, kann aber die Projekte dieser Organisation nicht auflisten, daher wurde nichts gespeichert. Haken Sie bei {{system}} zusätzlich Project and Team, Read an und versuchen Sie es erneut.",
      connector_scope:
        "Diesem Token fehlt der einzige nötige Bereich: Work Items, Read & write. Bearbeiten Sie es oder erstellen Sie ein anderes.",
      connector_no_organization: "{{system}} hat keine Organisation mit diesem Namen.",
      connector_setup:
        "{{system}} hat abgelehnt, obwohl die Verbindung gerade erneuert wurde: Neu verbinden hilft nicht. Wer diesen Server betreibt, sollte die Berechtigungen der {{system}}-App prüfen.",
      connector_reconnect:
        "{{system}} akzeptiert diese Verbindung nicht mehr. Verbinden Sie es erneut.",
      connector_token_refused:
        "{{system}} hat dieses Token abgelehnt oder eine Anmeldung verlangt. Es ist vielleicht abgelaufen, widerrufen oder braucht eine neue Anmeldung bei {{system}}. Versuchen Sie es danach erneut, oder fügen Sie in der Warteschlange ein neues Token ein.",
      connector_no_site: "Wählen Sie zuerst eine {{system}}-Website in der Warteschlange.",
      connector_no_field: "Wählen Sie zuerst das Feld für die Schätzung in der Warteschlange.",
      connector_bad_site: "Diese Website steht nicht mehr auf Ihrer {{system}}-Liste.",
      connector_bad_field: "Dieses Feld ist kein Zahlenfeld dieser Website.",
      connector_other_site:
        "Dieser Eintrag gehört zu einer anderen {{system}}-Website als der, mit der Sie verbunden sind.",
      connector_no_source: "Dieser Eintrag stammt nicht aus {{system}}.",
      connector_no_final: "Halten Sie zuerst eine endgültige Schätzung fest.",
      connector_not_numeric: "Nur eine Zahl geht an {{system}}, diese Schätzung bleibt also hier.",
      connector_rate_limited:
        "{{system}} bittet um weniger Tempo. Versuchen Sie es gleich noch einmal.",
      connector_rate_limited_wait:
        "{{system}} bittet um weniger Tempo. Versuchen Sie es in {{seconds, number}} s erneut.",
      connector_forbidden: "Ihr Konto bei {{system}} darf das nicht.",
      connector_not_found: "{{system}} findet das nicht, oder Ihr Konto darf es nicht sehen.",
      connector_bad_query:
        "{{system}} konnte diese Abfrage nicht ausführen. Prüfen Sie sie und versuchen Sie es erneut.",
      connector_field_refused:
        "{{system}} hat das Feld bei diesem Eintrag abgelehnt: Vielleicht ist es nicht auf seiner Maske.",
      connector_no_estimate_field:
        "Dieser Eintrag hat kein Schätzfeld, daher wurde nichts geschrieben.",
      connector_query_cap:
        "Diese Abfrage findet mehr, als {{system}} zurückgibt. Grenzen Sie sie ein und versuchen Sie es erneut.",
      connector_unavailable: "{{system}} antwortet nicht richtig. Versuchen Sie es später erneut.",
      connector_timeout: "{{system}} hat zu lange gebraucht. Versuchen Sie es erneut.",
    },
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
    not_keeper: "Sie können diesen Raum nicht löschen: Dieses Recht liegt nicht bei Ihnen.",
    sign_in_again: "Melden Sie sich zuerst erneut an: Das erfordert eine aktuelle Anmeldung.",
    bad_confirmation: "Das ist nicht das verlangte Wort. Nichts wurde gelöscht.",
    already_joined: "Sie sind bereits in diesem Raum.",
    bad_avatar: "Dieser Avatar ist nicht verfügbar. Wählen Sie einen anderen.",
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
    bad_card: "Diese Karte gehört nicht zum Kartendeck des Raums. Wählen Sie eine andere.",
    round_revealed: "Die Karten sind bereits aufgedeckt. Stimmen lassen sich nicht mehr ändern.",
    round_changed:
      "Eine neue Runde hat begonnen, bevor Ihre Stimme ankam. Wählen Sie Ihre Karte erneut.",
    not_voting: "In dieser Runde kann gerade nicht abgestimmt werden.",
    not_allowed: "Die Einstellungen dieses Raums erlauben das nicht.",
    too_few_cards:
      "Nicht aufgedeckt: In einer anonymen Runde zeigt eine einzelne Karte, von wem sie ist. Warten Sie auf eine zweite Karte.",
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
    bad_queue_item:
      "Einer dieser Einträge kann nicht in die Warteschlange. Prüfen Sie ihn und versuchen Sie es erneut.",
    queue_full:
      "Die Warteschlange ist voll: Sie fasst höchstens {{max, number}} Einträge, bei langen weniger.",
    unknown_item: "Dieser Eintrag ist nicht mehr in der Warteschlange.",
    bad_restriction:
      "Einer dieser Einträge ist weder eine Domain noch eine Mandanten-ID, oder es sind zu viele. Prüfen Sie sie und versuchen Sie es erneut.",
    owner_not_allowed:
      "Nur wer die Anmelderegel dieses Raums erfüllt, kann sein Product Owner werden.",
    sign_in_required:
      "Dieser Raum ist bestimmten Konten vorbehalten. Melden Sie sich an, um fortzufahren.",
    account_not_allowed: "Mit diesem Konto können Sie diesem Raum nicht beitreten.",
    session_too_old:
      "Ihre Anmeldung ist für diesen Raum zu alt. Melden Sie sich ab und dann wieder an.",
    restriction_unavailable:
      "Dieser Server bietet diese Anmeldung nicht mehr an, darum kann niemand diese Regel erfüllen.",
    deck_empty: "Ein Kartendeck braucht mindestens eine Karte.",
    deck_too_many_cards:
      "Ein Kartendeck hat höchstens {{max, number}} Karten. Entfernen Sie einige und versuchen Sie es erneut.",
    card_empty: "Eine Karte darf nicht leer sein.",
    card_invalid:
      "Diese Karte enthält Zeichen, die sich nicht anzeigen lassen. Geben Sie sie erneut ein.",
    card_too_long: "Eine Kartenbeschriftung hat höchstens {{max, number}} Zeichen. Kürzen Sie sie.",
    card_duplicate: "Diese Karte ist bereits im Kartendeck.",
    card_special:
      "Die Sonderkarten (?, ☕, ∞) schalten Sie in den Raumeinstellungen ein, nicht im Kartendeck.",
    bad_payload:
      "Der Server konnte diese Anfrage nicht lesen. Laden Sie die Seite neu und versuchen Sie es erneut.",
    protocol_mismatch: "Eine neue Version der App ist verfügbar. Laden Sie die Seite neu.",
    bad_room_name:
      "Ein Raumname hat {{min, number}} bis {{max, number}} sichtbare Zeichen. Kürzen Sie ihn, oder lassen Sie das Feld leer.",
    room_not_found:
      "Diesen Raum gibt es nicht, oder er wurde nach langer Zeit ohne Aktivität gelöscht. Prüfen Sie den Link.",
    password_required: "Dieser Raum hat ein Passwort. Geben Sie es ein, um beizutreten.",
    wrong_password: "Dieses Passwort ist nicht richtig.",
    bad_password: "Ein Passwort braucht {{min, number}} bis {{max, number}} Zeichen.",
    unauthenticated: "Ihre Sitzung ist abgelaufen. Laden Sie die Seite neu, um fortzufahren.",
    rate_limited: "Zu viele Versuche. Warten Sie einen Moment und versuchen Sie es dann erneut.",
    busy: "Der Raum war kurz beschäftigt. Versuchen Sie es erneut.",
    internal: "Auf dem Server ist etwas schiefgelaufen. Versuchen Sie es gleich noch einmal.",
    unknown: "Etwas ist schiefgelaufen. Versuchen Sie es erneut oder laden Sie die Seite neu.",
  },
};
