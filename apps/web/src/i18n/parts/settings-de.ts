import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./settings-en.ts";

// The room settings panel's words (#25 to #31, #50): the panel, the deck field, the rule and the
// password rows, in German. Loaded with its panel when the page speaks German: see copy-parts.ts.
export const copy: CatalogOf<typeof english> = {
  settings: {
    ledeOwner: "Jede Änderung gilt sofort für alle im Raum.",
    ledeOthers:
      "Der Product Owner legt die Regeln für diesen Raum fest. So ist er gerade eingestellt.",
    groupCards: "Karten",
    groupRound: "Abstimmen und Aufdecken",
    groupPeople: "Personen",
    on: "An",
    off: "Aus",
    saving: "Wird gespeichert…",
    connectionDropped: "Nicht gespeichert: Verbindung unterbrochen.",
    deck: "Kartendeck",
    deckHint: "Die Karten, aus denen alle wählen.",
    specials: "Sonderkarten",
    specialsHint:
      "Zusätzliche Karten für „unsicher“, „Pause nötig“ oder „zu groß zum Schätzen“. Sie zählen nie in den Ergebnissen.",
    specialsNone: "Keine",
    timer: "Timer für jede Runde",
    timerHint: "Jede Runde startet mit diesem Countdown. Eine Änderung gilt ab der nächsten Runde.",
    timerThenReveal: "Am Ende werden die Karten aufgedeckt.",
    timerThenTimeUp: "Am Ende sehen alle, dass die Zeit um ist.",
    timerCustom: "Eigene Dauer",
    timerCustomLabel: "Eigene Dauer",
    timerSet: "Übernehmen",
    timerRevealAtEnd: "Aufdecken, wenn der Timer abläuft",
    timerRevealAtEndHint: "Aus: Alle sehen, dass die Zeit um ist, und der Product Owner deckt auf.",
    whoCanReveal: "Wer aufdecken darf",
    whoCanRevealHint: "Wer die Karten aufdecken darf. Beobachter nie.",
    revealByOwner: "Der Product Owner",
    revealByAnyone: "Alle, die abstimmen",
    anonymous: "Anonyme Abstimmung",
    anonymousHint:
      "Die Ergebnisse zeigen die Karten ohne Namen. Eine Änderung gilt ab der nächsten Runde.",
    roundStaysNamed: "Diese Runde zeigt noch Namen.",
    roundStaysAnonymous: "Diese Runde bleibt anonym.",
    revealWhenAllVotedNow:
      "Alle haben abgestimmt: Wenn Sie das einschalten, werden die Karten sofort aufgedeckt.",
    revealWhenAllVoted: "Aufdecken, wenn alle abgestimmt haben",
    revealWhenAllVotedHint:
      "Die Karten werden von selbst aufgedeckt, sobald alle Anwesenden abgestimmt haben.",
    changeAfterReveal: "Stimme nach dem Aufdecken ändern",
    changeAfterRevealHint:
      "Wer abstimmt, kann die Karte nach dem Aufdecken noch ändern. Nie in einer anonymen Runde: Dort stehen die Stimmen mit dem Aufdecken fest.",
    changeAfterRevealLocked: "In anonymen Runden stehen die Stimmen mit dem Aufdecken fest.",
    allowed: "Erlaubt",
    notAllowed: "Nicht erlaubt",
    autoAdvance: "Nächsten Eintrag automatisch starten",
    autoAdvanceHint:
      "{{seconds, number}} Sekunden nach einer festgehaltenen Schätzung startet der nächste Eintrag der Warteschlange. Alle sehen den Countdown, und der Product Owner kann bei der Runde bleiben.",
    poVotes: "Der Product Owner stimmt mit ab",
    poVotesHint: "Aus: Der Product Owner leitet die Sitzung ohne Karten.",
    observersCount: "Beobachter belegen einen der {{max, number}} Plätze",
    observersCountHint:
      "Aus: Beobachter können auch einem vollen Raum beitreten, bis zu {{total, number}} Personen insgesamt.",
    observersCountRefused:
      "Mit den Beobachtern sind mehr als {{max, number}} Personen hier. Beobachter zählen wieder, sobald es {{max, number}} oder weniger sind.",
    restriction: "Wer beitreten kann",
    restrictionHint:
      "Beschränken Sie diesen Raum auf bestimmte Konten. Wer den Link hat, sieht die erlaubten Domains und kann so das richtige Konto wählen.",
    restrictionAnyone: "Alle mit dem Link",
    restrictionLimited: "Beschränkt",
  },
  deckField: {
    inUse: "Aktiv",
    use: "{{deck}} verwenden",
    customLabel: "Karten, durch Kommas getrennt",
    customHint:
      "Bis zu {{max, number}} Karten mit je höchstens {{length, number}} Zeichen, auch Emoji. Das Komma trennt die Karten, schreiben Sie Dezimalzahlen daher mit Punkt: 0.5.",
    customCount_one: "{{count, number}} Karte",
    customCount_other: "{{count, number}} Karten",
    useCustom: "Diese Karten verwenden",
    fromNextRound: "Neue Karten gelten ab Runde {{round, number}}.",
    restartsRound:
      "Neue Karten starten Runde {{round, number}} neu: Die Stimmen werden gelöscht, das Thema bleibt.",
    deckQuestion_one:
      "Ein neues Kartendeck startet Runde {{round, number}} neu. Die bisher abgegebene Stimme wird gelöscht, das Thema bleibt.",
    deckQuestion_other:
      "Ein neues Kartendeck startet Runde {{round, number}} neu. Die {{count, number}} bisher abgegebenen Stimmen werden gelöscht, das Thema bleibt.",
    specialsQuestion_one:
      "Neue Sonderkarten starten Runde {{round, number}} neu. Die bisher abgegebene Stimme wird gelöscht, das Thema bleibt.",
    specialsQuestion_other:
      "Neue Sonderkarten starten Runde {{round, number}} neu. Die {{count, number}} bisher abgegebenen Stimmen werden gelöscht, das Thema bleibt.",
    restartWith: "Mit {{deck}} neu starten",
    restartSpecials: "Mit den neuen Sonderkarten neu starten",
    cancel: "Abbrechen",
    deck_empty: "Geben Sie mindestens eine Karte ein.",
    deck_too_many_cards:
      "Das sind {{count, number}} Karten; ein Kartendeck hat höchstens {{max, number}}.",
    card_empty: "Karte {{position, number}} ist leer. Entfernen Sie das überzählige Komma.",
    card_invalid:
      "Karte {{position, number}} enthält Zeichen, die sich nicht anzeigen lassen. Geben Sie sie neu ein.",
    card_too_long: "„{{card}}“ ist zu lang: Eine Karte hat höchstens {{max, number}} Zeichen.",
    card_duplicate: "„{{card}}“ steht zweimal im Kartendeck. Behalten Sie eine.",
    card_same_value:
      "„{{card}}“ hat denselben Wert wie „{{other}}“. Behalten Sie nur eine der beiden.",
    card_special:
      "„{{card}}“ ist eine Sonderkarte. Schalten Sie sie unter „Sonderkarten“ ein, statt sie einzugeben.",
    rangeOpen: "Zahlenfolge erzeugen",
    rangeStart: "Start",
    rangeEnd: "Ende",
    rangeStep: "Schritt",
    rangeHint:
      "Zahlen, mit Komma oder Punkt als Dezimalzeichen. Die Karten landen im Feld darüber, wo Sie sie noch ändern können.",
    rangeFill: "Karten einfügen",
    rangeFilled_one:
      "{{count, number}} Karte eingefügt. Prüfen Sie sie und verwenden Sie sie dann.",
    rangeFilled_other:
      "{{count, number}} Karten eingefügt. Prüfen Sie sie und verwenden Sie sie dann.",
    range_not_finite: "Geben Sie für Start, Ende und Schritt je eine Zahl ein, etwa 0,5 oder 0.5.",
    range_step_not_positive: "Der Schritt muss größer als 0 sein.",
    range_end_before_start: "Das Ende darf nicht kleiner als der Start sein.",
    range_too_many_cards:
      "Diese Folge ergibt mehr als {{max, number}} Karten. Wählen Sie einen größeren Schritt oder eine kürzere Folge.",
    range_label_too_long:
      "Manche Werte bräuchten mehr als {{max, number}} Zeichen, etwa 0,125 oder 10000. Verwenden Sie weniger Nachkommastellen oder kleinere Zahlen.",
    specialUnsure: "Unsicher",
    specialCoffee: "Pause nötig",
    specialInfinite: "Zu groß zum Schätzen",
  },
  restriction: {
    yourOrganisation: "Ihre Organisation",
    signInFirst: "Melden Sie sich an, um diesen Raum auf bestimmte Konten zu beschränken.",
    domainsLabel: "E-Mail-Domains",
    domainsHint:
      "Eine pro Zeile, exakt: example.com lässt mail.example.com nicht zu. Es zählt nur ein Google-Konto, dessen Adresse Google bestätigt hat, und das belegt nur, dass jemand dort einmal E-Mails empfangen konnte, auch über ein gemeinsames Postfach.",
    tenantsLabel: "Microsoft-Mandanten-IDs",
    tenantsHint:
      "Eine pro Zeile. Wer sich mit Microsoft anmeldet, kommt über die Mandanten-ID der Organisation herein, nie über die Adresse: Eine Domain oben lässt diese Personen nicht zu.",
    googleGone:
      "Dieser Server bietet keine Google-Anmeldung mehr an: Über eine Domain kommt niemand herein.",
    microsoftGone:
      "Dieser Server bietet keine Microsoft-Anmeldung mehr an: Über einen Mandanten kommt niemand herein.",
    badDomain: "Das ist keine Domain: {{entry}}",
    badTenant: "Das ist keine Mandanten-ID einer Organisation: {{entry}}",
    tooMany: "Jede Liste fasst höchstens {{max, number}} Einträge.",
    outsiders_one:
      "{{count, number}} Person hier würde nicht zugelassen. Sie bleibt, bis sie die Seite neu lädt, die Verbindung verliert oder geht.",
    outsiders_other:
      "{{count, number}} Personen hier würden nicht zugelassen. Sie bleiben, bis sie die Seite neu laden, die Verbindung verlieren oder gehen.",
    askFirst:
      "Sie erfüllen diese Regel selbst nicht. Sie bleiben, solange Sie Product Owner sind, könnten aber nach einer Übergabe der Rolle nicht zurückkommen.",
    removeOutsiders: "Alle entfernen, die nicht zugelassen würden",
    removeAsk_one:
      "{{count, number}} Person verlässt den Raum sofort und kann nur mit einem zugelassenen Konto zurückkommen.",
    removeAsk_other:
      "{{count, number}} Personen verlassen den Raum sofort und können nur mit einem zugelassenen Konto zurückkommen.",
    removeConfirm: "Entfernen",
    askConfirm: "Trotzdem speichern",
    save: "Regel speichern",
    remove: "Regel entfernen",
  },
  password: {
    settingHint: "Wer schon im Raum ist, bleibt. Alle anderen geben es auf jedem Gerät einmal ein.",
    set: "Passwort festlegen",
    save: "Passwort speichern",
    change: "Passwort ändern",
    remove: "Passwort entfernen",
    cancel: "Abbrechen",
  },
};
