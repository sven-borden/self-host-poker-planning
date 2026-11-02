import { useCallback } from "react";
import { useLanguage } from "../i18n/hooks.ts";
import { translateIn } from "../i18n/i18n.ts";
import type { Language } from "../i18n/language.ts";

// The account page's words (#51, ADR-029), in the route's own chunk: only someone who goes there
// needs them, and the catalogs that load with every page are what the room route's budget pays
// for. All three languages sit here, and `i18n.test.ts` holds them to everything it holds the
// catalogs to.

const en = {
  title: "Your account",
  loading: "Loading your account…",
  signedOut:
    "Sign in to download your data or delete your account. What you did as a guest comes with you.",
  moving: "Some of your rooms are still on their way to your account. Try again in a moment.",

  exportTitle: "Your data",
  exportBody:
    "Download a JSON file of what this server holds about you: your profile, how you sign in, your rooms, the rooms a password let you into, your own cards in named rounds and your connections. It holds nobody else’s name or card. Anonymous rounds are not in it: nothing ties you to a card there.",
  exportCodes:
    "Rooms appear by their name and id, never by their code: a code opens a room, and this file may travel.",
  exportAction: "Download my data",
  exportBusy: "Preparing your file…",
  exported: "Your file is on its way.",
  exportMore_one:
    "{{count, number}} room appears by its id alone: sign in again to have all of it.",
  exportMore_other:
    "{{count, number}} rooms appear by their id alone: sign in again to have all of them.",
  exportIncomplete:
    "Your file is on its way, but some rooms had not reached your account yet. Download it again in a moment.",

  deleteTitle: "Delete my account",
  deleteIntro:
    "This cannot be undone. You are signed out everywhere first, and nobody can use the account from then on.",
  goesTitle: "What goes",
  goesAccount: "Your name, your address, how you sign in, your avatar and your connections.",
  goesAlone_one: "{{count, number}} room with nobody else in it, with its history.",
  goesAlone_other: "{{count, number}} rooms with nobody else in them, with their history.",
  goesSeats_one: "Your seat in {{count, number}} room that belongs to someone else.",
  goesSeats_other: "Your seat in {{count, number}} rooms that belong to someone else.",
  goesHeld_one:
    "Your right to {{count, number}} room whose rule does not admit this account. The room stays.",
  goesHeld_other:
    "Your right to {{count, number}} rooms whose rule does not admit this account. Those rooms stay.",
  goesAfter_one: "A room nobody may hold goes after {{count, number}} day without activity.",
  goesAfter_other: "A room nobody may hold goes after {{count, number}} days without activity.",
  moreRooms_one:
    "Sign in again to see {{count, number}} more room: its rule asks for a recent sign-in.",
  moreRooms_other:
    "Sign in again to see {{count, number}} more rooms: their rule asks for a recent sign-in.",
  goesNames: "Your name on your cards in named rounds.",
  staysTitle: "What stays",
  staysCards:
    "Your cards in past rounds, with no name and nothing that ties them to you, so the team’s results stand.",
  staysWords:
    "Words you typed in a room that lives on: its name, a round’s subject, a ticket in its queue. The server cannot know which of them speak of you.",
  staysCopies:
    "What other people already hold: an export, a screenshot, what they remember. Those are theirs.",
  staysBackups:
    "Backups of this server keep your data until they expire. If one is ever restored, your account comes back with it, and you can delete it again.",
  staysLogs: "Server logs hold ids, never your name or address, and age as logs do.",

  sharedTitle: "Rooms with other people in them",
  sharedIntro:
    "These rooms are yours, and other people sit in them. Choose who takes each one: the room and the right to delete it go to that person. If you choose nobody, it goes to whoever runs the room now, if they are here; otherwise to the person here who has been seated longest; otherwise to the person seated longest. Only someone a room’s rule admits can take it. A room goes only if you say so.",
  sharedGuest_one:
    "A room that goes to a guest stays for as long as it is used: after {{count, number}} day without activity, it is deleted.",
  sharedGuest_other:
    "A room that goes to a guest stays for as long as it is used: after {{count, number}} days without activity, it is deleted.",
  unnamed: "Room without a name",
  takerLabel: "Who takes {{name}}",
  takerNobody: "Nobody here",
  takerRunning: "{{name}} runs the room now.",
  takerHere: "{{name}} is here, and has been seated longest.",
  takerAway: "Nobody who may take it is here. {{name}} has been seated longest.",
  takerChosen: "{{name}} takes this room and the right to delete it.",
  takerNone: "Nobody here may take this room, so it stays with nobody holding it.",
  takerDelete: "Nobody: delete this room",
  deleteChosen:
    "This room goes for everyone in it, with its history, the moment your account does.",

  againBody:
    "To delete your account, you need to have signed in within the last 15 minutes, so that a browser left open cannot do it. You come back to this page.",
  againAction: "Sign in again",
  againWith: "Sign in again with {{provider}}",
  againNeeded: "That sign-in is too old by now. Sign in again to go on.",
  deleteAction: "Delete my account",

  confirmTitle: "Delete your account for good?",
  confirmBody:
    "This cannot be undone. What is listed on the page goes now, and the rooms go as you chose.",
  confirmLabel: "Type {{word}} to confirm",
  cancel: "Cancel",
  confirmAction: "Delete my account",
  deleting: "Deleting your account…",

  nothingDeleted: "Nothing was deleted, and you are still signed in. Try again.",
  noAnswer:
    "The server does not answer, and your request may or may not have reached it. Reload this page once you are back online.",

  doneTitle: "Your account is deleted",
  doneBody:
    "Nothing under your name is left on this server. This browser is a new guest now, with nothing from before, and signing in again starts a new account.",
  doneRemains:
    "What remains is what this page said: backups until they expire, copies other people hold, and logs that hold ids.",
  goingTitle: "Your account is being deleted",
  goingBody:
    "You are signed out everywhere, and nobody can use the account. Some of it has not gone yet: that finishes by itself, within two days, and you have nothing more to do. A rare fault can take longer. Signing in with this account says so until it is done.",
  lostTitle: "You are signed out",
  lostBody:
    "The server did not answer in time, and you are signed out. That is how a deletion starts, so it most likely went through, and it finishes by itself. If you sign in and your account is still there, nothing was deleted.",
  outBody:
    "Your session ended before this request arrived, so this request deleted nothing. Sign in to delete your account or to download your data.",
  home: "Back to the start",
};

type Copy = { readonly [K in keyof typeof en]: string };

type FrenchMany =
  | "goesAlone"
  | "goesSeats"
  | "goesHeld"
  | "goesAfter"
  | "moreRooms"
  | "exportMore"
  | "sharedGuest";

const fr: Copy & Partial<Record<`${FrenchMany}_many`, string>> = {
  title: "Votre compte",
  loading: "Chargement de votre compte…",
  signedOut:
    "Connectez-vous pour télécharger vos données ou supprimer votre compte. Ce que vous avez fait en tant qu’invité vous suit.",
  moving:
    "Certaines de vos salles sont encore en cours de transfert vers votre compte. Réessayez dans un instant.",

  exportTitle: "Vos données",
  exportBody:
    "Téléchargez un fichier JSON de ce que ce serveur détient à votre sujet : votre profil, votre mode de connexion, vos salles, les salles ouvertes par un mot de passe, vos propres cartes dans les tours nominatifs et vos connexions. Il ne contient ni le nom ni la carte de personne d’autre. Les tours anonymes n’y figurent pas : rien ne vous y relie à une carte.",
  exportCodes:
    "Les salles y figurent par leur nom et leur identifiant, jamais par leur code : un code ouvre une salle, et ce fichier peut circuler.",
  exportAction: "Télécharger mes données",
  exportBusy: "Préparation de votre fichier…",
  exported: "Votre téléchargement commence.",
  exportMore_one:
    "{{count, number}} salle n’y figure que par son identifiant : reconnectez-vous pour tout avoir.",
  exportMore_many:
    "{{count, number}} de salles n’y figurent que par leur identifiant : reconnectez-vous pour tout avoir.",
  exportMore_other:
    "{{count, number}} salles n’y figurent que par leur identifiant : reconnectez-vous pour tout avoir.",
  exportIncomplete:
    "Votre téléchargement commence, mais certaines salles n’avaient pas encore rejoint votre compte. Téléchargez le fichier à nouveau dans un instant.",

  deleteTitle: "Supprimer mon compte",
  deleteIntro:
    "Cette action est irréversible. Toutes vos sessions se ferment d’abord, et plus personne ne peut utiliser le compte ensuite.",
  goesTitle: "Ce qui disparaît",
  goesAccount: "Votre nom, votre adresse, votre mode de connexion, votre avatar et vos connexions.",
  goesAlone_one: "{{count, number}} salle sans personne d’autre, avec son historique.",
  goesAlone_many: "{{count, number}} de salles sans personne d’autre, avec leur historique.",
  goesAlone_other: "{{count, number}} salles sans personne d’autre, avec leur historique.",
  goesSeats_one: "Votre place dans {{count, number}} salle qui appartient à quelqu’un d’autre.",
  goesSeats_many: "Votre place dans {{count, number}} de salles qui appartiennent à d’autres.",
  goesSeats_other: "Votre place dans {{count, number}} salles qui appartiennent à d’autres.",
  goesHeld_one:
    "Votre droit sur {{count, number}} salle dont la règle n’admet pas ce compte. La salle reste.",
  goesHeld_many:
    "Votre droit sur {{count, number}} de salles dont la règle n’admet pas ce compte. Ces salles restent.",
  goesHeld_other:
    "Votre droit sur {{count, number}} salles dont la règle n’admet pas ce compte. Ces salles restent.",
  goesAfter_one:
    "Une salle que personne ne peut reprendre disparaît après {{count, number}} jour sans activité.",
  goesAfter_many:
    "Une salle que personne ne peut reprendre disparaît après {{count, number}} de jours sans activité.",
  goesAfter_other:
    "Une salle que personne ne peut reprendre disparaît après {{count, number}} jours sans activité.",
  moreRooms_one:
    "Reconnectez-vous pour voir {{count, number}} salle de plus : sa règle demande une connexion récente.",
  moreRooms_many:
    "Reconnectez-vous pour voir {{count, number}} de salles de plus : leur règle demande une connexion récente.",
  moreRooms_other:
    "Reconnectez-vous pour voir {{count, number}} salles de plus : leur règle demande une connexion récente.",
  goesNames: "Votre nom sur vos cartes dans les tours nominatifs.",
  staysTitle: "Ce qui reste",
  staysCards:
    "Vos cartes des tours passés, sans nom et sans rien qui vous y relie, pour que les résultats de l’équipe restent valables.",
  staysWords:
    "Les mots saisis dans une salle qui continue : son nom, le sujet d’un tour, un ticket de sa file. Le serveur ne peut pas savoir lesquels parlent de vous.",
  staysCopies:
    "Ce que d’autres détiennent déjà : un export, une capture d’écran, leurs souvenirs. Cela leur appartient.",
  staysBackups:
    "Les sauvegardes de ce serveur conservent vos données jusqu’à leur expiration. Si l’une d’elles est restaurée, votre compte revient avec elle, et vous pouvez le supprimer à nouveau.",
  staysLogs:
    "Les journaux du serveur contiennent des identifiants, jamais votre nom ni votre adresse, et vieillissent comme tout journal.",

  sharedTitle: "Salles où d’autres personnes sont présentes",
  sharedIntro:
    "Ces salles sont les vôtres, et d’autres personnes y ont une place. Choisissez qui reprend chacune\u{202f}: la salle et le droit de la supprimer vont à cette personne. Sans choix de votre part, elle revient à la personne qui l’anime en ce moment si elle est là\u{202f}; sinon à la personne présente qui y a sa place depuis le plus longtemps\u{202f}; sinon à celle qui y a sa place depuis le plus longtemps. Seule une personne admise par la règle d’une salle peut la reprendre. Une salle ne disparaît que si vous le demandez.",
  sharedGuest_one:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} jour sans activité, elle est supprimée.",
  sharedGuest_many:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} de jours sans activité, elle est supprimée.",
  sharedGuest_other:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} jours sans activité, elle est supprimée.",
  unnamed: "Salle sans nom",
  takerLabel: "Qui reprend {{name}}",
  takerNobody: "Personne ici",
  takerRunning: "{{name}} anime la salle en ce moment.",
  takerHere: "{{name}} est là, et y a sa place depuis le plus longtemps.",
  takerAway:
    "Aucune personne pouvant la reprendre n’est là. {{name}} y a sa place depuis le plus longtemps.",
  takerChosen: "{{name}} reprend cette salle et le droit de la supprimer.",
  takerNone: "Personne ici ne peut reprendre cette salle\u{202f}: elle reste sans propriétaire.",
  takerDelete: "Personne : supprimer cette salle",
  deleteChosen:
    "Cette salle disparaît pour tous ses participants, avec son historique, dès que votre compte disparaît.",

  againBody:
    "Pour supprimer votre compte, votre connexion doit dater de moins de 15 minutes : un navigateur resté ouvert ne doit pas pouvoir le faire. Vous revenez ensuite sur cette page.",
  againAction: "Se reconnecter",
  againWith: "Se reconnecter avec {{provider}}",
  againNeeded: "Cette connexion est désormais trop ancienne. Reconnectez-vous pour continuer.",
  deleteAction: "Supprimer mon compte",

  confirmTitle: "Supprimer définitivement votre compte ?",
  confirmBody:
    "Cette action est irréversible. Ce que la page énumère disparaît maintenant, et les salles suivent vos choix.",
  confirmLabel: "Saisissez {{word}} pour confirmer",
  cancel: "Annuler",
  confirmAction: "Supprimer mon compte",
  deleting: "Suppression de votre compte…",

  nothingDeleted: "Rien n’a été supprimé, et votre session reste ouverte. Réessayez.",
  noAnswer:
    "Le serveur ne répond pas, et votre demande a pu lui parvenir ou non. Rechargez cette page une fois de retour en ligne.",

  doneTitle: "Votre compte est supprimé",
  doneBody:
    "Plus rien à votre nom ne reste sur ce serveur. Ce navigateur est désormais un nouvel invité, sans rien d’avant, et une nouvelle connexion crée un nouveau compte.",
  doneRemains:
    "Ce qui reste est ce que cette page annonçait : les sauvegardes jusqu’à leur expiration, les copies détenues par d’autres et les journaux qui contiennent des identifiants.",
  goingTitle: "Votre compte est en cours de suppression",
  goingBody:
    "Toutes vos sessions sont fermées, et plus personne ne peut utiliser le compte. Une partie n’a pas encore disparu : cela se termine tout seul, en deux jours au plus, et vous n’avez plus rien à faire. Une panne rare peut prendre plus de temps. Une connexion avec ce compte le signale jusqu’à la fin.",
  lostTitle: "Votre session est fermée",
  lostBody:
    "Le serveur n’a pas répondu à temps, et votre session est fermée. C’est ainsi que commence une suppression : elle a très probablement abouti, et elle se termine toute seule. Si vous vous connectez et que votre compte est toujours là, rien n’a été supprimé.",
  outBody:
    "Votre session s’est fermée avant l’arrivée de cette demande : cette demande n’a donc rien supprimé. Connectez-vous pour supprimer votre compte ou télécharger vos données.",
  home: "Retour à l’accueil",
};

const de: Copy = {
  title: "Ihr Konto",
  loading: "Ihr Konto wird geladen…",
  signedOut:
    "Melden Sie sich an, um Ihre Daten herunterzuladen oder Ihr Konto zu löschen. Was Sie als Gast getan haben, kommt mit.",
  moving:
    "Einige Ihrer Räume werden noch in Ihr Konto übertragen. Versuchen Sie es gleich noch einmal.",

  exportTitle: "Ihre Daten",
  exportBody:
    "Laden Sie eine JSON-Datei mit dem herunter, was dieser Server über Sie speichert: Ihr Profil, Ihre Anmeldung, Ihre Räume, die Räume, die Ihnen ein Passwort geöffnet hat, Ihre eigenen Karten in Runden mit Namen und Ihre Verbindungen. Sie enthält weder Namen noch Karten anderer Personen. Anonyme Runden fehlen darin: Dort verbindet Sie nichts mit einer Karte.",
  exportCodes:
    "Räume stehen darin mit Name und ID, nie mit ihrem Code: Ein Code öffnet einen Raum, und diese Datei kann weitergegeben werden.",
  exportAction: "Meine Daten herunterladen",
  exportBusy: "Ihre Datei wird vorbereitet…",
  exported: "Ihre Datei wird heruntergeladen.",
  exportMore_one:
    "{{count, number}} Raum steht nur mit seiner ID darin: Melden Sie sich erneut an, um alles zu erhalten.",
  exportMore_other:
    "{{count, number}} Räume stehen nur mit ihrer ID darin: Melden Sie sich erneut an, um alles zu erhalten.",
  exportIncomplete:
    "Ihre Datei wird heruntergeladen, aber einige Räume waren noch nicht in Ihrem Konto. Laden Sie sie gleich noch einmal herunter.",

  deleteTitle: "Mein Konto löschen",
  deleteIntro:
    "Das lässt sich nicht rückgängig machen. Sie werden zuerst überall abgemeldet, und danach kann niemand das Konto mehr nutzen.",
  goesTitle: "Was verschwindet",
  goesAccount: "Ihr Name, Ihre Adresse, Ihre Anmeldung, Ihr Avatar und Ihre Verbindungen.",
  goesAlone_one: "{{count, number}} Raum, in dem sonst niemand ist, mit seinem Verlauf.",
  goesAlone_other: "{{count, number}} Räume, in denen sonst niemand ist, mit ihrem Verlauf.",
  goesSeats_one: "Ihr Platz in {{count, number}} Raum, der jemand anderem gehört.",
  goesSeats_other: "Ihr Platz in {{count, number}} Räumen, die anderen gehören.",
  goesHeld_one:
    "Ihr Recht an {{count, number}} Raum, dessen Regel dieses Konto nicht zulässt. Der Raum bleibt.",
  goesHeld_other:
    "Ihr Recht an {{count, number}} Räumen, deren Regel dieses Konto nicht zulässt. Diese Räume bleiben.",
  goesAfter_one:
    "Ein Raum, den niemand übernehmen darf, verschwindet nach {{count, number}} Tag ohne Aktivität.",
  goesAfter_other:
    "Ein Raum, den niemand übernehmen darf, verschwindet nach {{count, number}} Tagen ohne Aktivität.",
  moreRooms_one:
    "Melden Sie sich erneut an, um {{count, number}} weiteren Raum zu sehen: Seine Regel verlangt eine aktuelle Anmeldung.",
  moreRooms_other:
    "Melden Sie sich erneut an, um {{count, number}} weitere Räume zu sehen: Ihre Regel verlangt eine aktuelle Anmeldung.",
  goesNames: "Ihr Name auf Ihren Karten in Runden mit Namen.",
  staysTitle: "Was bleibt",
  staysCards:
    "Ihre Karten aus vergangenen Runden, ohne Namen und ohne etwas, das sie mit Ihnen verbindet, damit die Ergebnisse des Teams erhalten bleiben.",
  staysWords:
    "Was Sie in einem Raum getippt haben, der weiterbesteht: sein Name, das Thema einer Runde, ein Ticket in seiner Warteschlange. Der Server kann nicht wissen, was davon Sie betrifft.",
  staysCopies:
    "Was andere bereits haben: einen Export, einen Screenshot, ihre Erinnerung. Das gehört ihnen.",
  staysBackups:
    "Sicherungen dieses Servers behalten Ihre Daten, bis sie ablaufen. Wird eine davon wiederhergestellt, kommt Ihr Konto mit ihr zurück, und Sie können es erneut löschen.",
  staysLogs:
    "Server-Protokolle enthalten IDs, nie Ihren Namen oder Ihre Adresse, und altern wie alle Protokolle.",

  sharedTitle: "Räume mit anderen Personen",
  sharedIntro:
    "Diese Räume gehören Ihnen, und andere Personen haben dort einen Platz. Wählen Sie, wer jeden Raum übernimmt: Der Raum und das Recht, ihn zu löschen, gehen an diese Person. Ohne Wahl geht er an die Person, die ihn gerade leitet, falls sie da ist, sonst an die Person, die da ist und am längsten dabei ist, sonst an die Person, die am längsten dabei ist. Übernehmen kann ihn nur, wen seine Regel zulässt. Ein Raum verschwindet nur, wenn Sie das sagen.",
  sharedGuest_one:
    "Ein Raum, den ein Gast übernimmt, bleibt, solange er genutzt wird: Nach {{count, number}} Tag ohne Aktivität wird er gelöscht.",
  sharedGuest_other:
    "Ein Raum, den ein Gast übernimmt, bleibt, solange er genutzt wird: Nach {{count, number}} Tagen ohne Aktivität wird er gelöscht.",
  unnamed: "Raum ohne Namen",
  takerLabel: "Wer übernimmt {{name}}",
  takerNobody: "Niemand hier",
  takerRunning: "{{name}} leitet den Raum gerade.",
  takerHere: "{{name}} ist da und am längsten dabei.",
  takerAway: "Niemand, der ihn übernehmen darf, ist da. {{name}} ist am längsten dabei.",
  takerChosen: "{{name}} übernimmt diesen Raum und das Recht, ihn zu löschen.",
  takerNone: "Niemand hier darf diesen Raum übernehmen, also bleibt er ohne Inhaber.",
  takerDelete: "Niemand: diesen Raum löschen",
  deleteChosen:
    "Dieser Raum verschwindet für alle darin, mit seinem Verlauf, sobald Ihr Konto verschwindet.",

  againBody:
    "Um Ihr Konto zu löschen, müssen Sie sich in den letzten 15 Minuten angemeldet haben, damit ein offen gelassener Browser das nicht kann. Danach kommen Sie auf diese Seite zurück.",
  againAction: "Erneut anmelden",
  againWith: "Erneut mit {{provider}} anmelden",
  againNeeded: "Diese Anmeldung ist inzwischen zu alt. Melden Sie sich erneut an, um fortzufahren.",
  deleteAction: "Mein Konto löschen",

  confirmTitle: "Ihr Konto endgültig löschen?",
  confirmBody:
    "Das lässt sich nicht rückgängig machen. Was die Seite aufzählt, verschwindet jetzt, und die Räume folgen Ihrer Wahl.",
  confirmLabel: "Geben Sie {{word}} ein, um zu bestätigen",
  cancel: "Abbrechen",
  confirmAction: "Mein Konto löschen",
  deleting: "Ihr Konto wird gelöscht…",

  nothingDeleted:
    "Nichts wurde gelöscht, und Sie sind weiterhin angemeldet. Versuchen Sie es erneut.",
  noAnswer:
    "Der Server antwortet nicht, und Ihre Anfrage hat ihn vielleicht erreicht oder auch nicht. Laden Sie diese Seite neu, sobald Sie wieder online sind.",

  doneTitle: "Ihr Konto ist gelöscht",
  doneBody:
    "Unter Ihrem Namen ist auf diesem Server nichts mehr vorhanden. Dieser Browser gilt jetzt als neuer Gast, ohne Daten von früher, und eine neue Anmeldung legt ein neues Konto an.",
  doneRemains:
    "Was bleibt, ist, was diese Seite genannt hat: Sicherungen, bis sie ablaufen, Kopien anderer Personen und Protokolle mit IDs.",
  goingTitle: "Ihr Konto wird gelöscht",
  goingBody:
    "Sie sind überall abgemeldet, und niemand kann das Konto mehr nutzen. Ein Teil ist noch nicht verschwunden: Das erledigt sich von selbst, innerhalb von zwei Tagen, und Sie müssen nichts mehr tun. Ein seltener Fehler kann länger dauern. Eine Anmeldung mit diesem Konto sagt das, bis es erledigt ist.",
  lostTitle: "Sie sind abgemeldet",
  lostBody:
    "Der Server hat nicht rechtzeitig geantwortet, und Sie sind abgemeldet. So beginnt eine Löschung: Sie ist sehr wahrscheinlich angelaufen und läuft von selbst zu Ende. Wenn Sie sich anmelden und Ihr Konto noch da ist, wurde nichts gelöscht.",
  outBody:
    "Ihre Sitzung endete, bevor diese Anfrage ankam, also hat diese Anfrage nichts gelöscht. Melden Sie sich an, um Ihr Konto zu löschen oder Ihre Daten herunterzuladen.",
  home: "Zurück zur Startseite",
};

/** The page's words, per language: `i18n.test.ts` reads this too. */
export const ACCOUNT_COPY: Readonly<Record<Language, object>> = { en, fr, de };

type Plain<K> = K extends `${infer B}_${"one" | "other"}` ? B : K;

/** A key of the page's words, with its plural suffix taken off. */
export type AccountKey = Plain<keyof typeof en>;

export type AccountT = (
  key: AccountKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

/** A `t` for this page's words, in the current language. */
export function useAccountT(): AccountT {
  const [language] = useLanguage();
  return useCallback((key, values) => translateIn(ACCOUNT_COPY, language, key, values), [language]);
}
