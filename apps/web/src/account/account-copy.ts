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
    "Download a JSON file of what this server holds about you: your profile, how you sign in, your rooms, your own cards in named rounds and your connections. It holds nobody else’s name or card. Anonymous rounds are not in it: nothing ties you to a card there.",
  exportCodes:
    "Rooms appear by their name and id, never by their code: a code opens a room, and this file may travel.",
  exportAction: "Download my data",
  exportBusy: "Preparing your file…",
  exported: "Your file is on its way.",
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
  goesNames: "Your name on your cards in named rounds.",
  staysTitle: "What stays",
  staysCards:
    "Your cards in past rounds, with no name and nothing that ties them to you, so the team’s results stand.",
  staysWords:
    "Words you typed in a room that lives on: its name, a round’s subject, a ticket in its queue. The server cannot know which of them speak of you.",
  staysCopies:
    "What other people already hold: an export, a screenshot, what they remember. Those are theirs.",
  staysBackups:
    "Backups of this server keep your data until they expire. Whoever runs this server is told to delete you again after a restore.",
  staysLogs: "Server logs hold ids, never your name or address, and age as logs do.",

  sharedTitle: "Rooms with other people in them",
  sharedIntro:
    "These rooms are yours, and other people sit in them. Choose who takes each one: the room and the right to delete it go to that person. If you choose nobody, the person seated longest takes it. A room goes only if you say so.",
  sharedGuest_one:
    "A room that goes to a guest stays for as long as it is used: after {{count, number}} day without activity, it is deleted.",
  sharedGuest_other:
    "A room that goes to a guest stays for as long as it is used: after {{count, number}} days without activity, it is deleted.",
  unnamed: "Room without a name",
  takerLabel: "Who takes {{name}}",
  takerDefault: "{{name}} (seated longest)",
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
    "You are signed out everywhere, and nobody can use the account. Some of it has not gone yet: that finishes by itself, within a day, and you have nothing more to do. Signing in with this account says so until it is done.",
  lostTitle: "You are signed out",
  lostBody:
    "The server did not answer in time, and you are signed out. That is how a deletion starts, so it most likely went through, and it finishes by itself. If you sign in and your account is still there, nothing was deleted.",
  home: "Back to the start",
};

type Copy = { readonly [K in keyof typeof en]: string };

const fr: Copy & Partial<Record<`${"goesAlone" | "goesSeats" | "sharedGuest"}_many`, string>> = {
  title: "Votre compte",
  loading: "Chargement de votre compte…",
  signedOut:
    "Connectez-vous pour télécharger vos données ou supprimer votre compte. Ce que vous avez fait en tant qu’invité vous suit.",
  moving:
    "Certaines de vos salles sont encore en cours de transfert vers votre compte. Réessayez dans un instant.",

  exportTitle: "Vos données",
  exportBody:
    "Téléchargez un fichier JSON de ce que ce serveur détient à votre sujet : votre profil, votre mode de connexion, vos salles, vos propres cartes dans les tours nominatifs et vos connexions. Il ne contient ni le nom ni la carte de personne d’autre. Les tours anonymes n’y figurent pas : rien ne vous y relie à une carte.",
  exportCodes:
    "Les salles y figurent par leur nom et leur identifiant, jamais par leur code : un code ouvre une salle, et ce fichier peut circuler.",
  exportAction: "Télécharger mes données",
  exportBusy: "Préparation de votre fichier…",
  exported: "Votre fichier arrive.",
  exportIncomplete:
    "Votre fichier arrive, mais certaines salles n’avaient pas encore rejoint votre compte. Téléchargez-le à nouveau dans un instant.",

  deleteTitle: "Supprimer mon compte",
  deleteIntro:
    "Cette action est irréversible. Vous êtes d’abord déconnecté partout, et plus personne ne peut utiliser le compte ensuite.",
  goesTitle: "Ce qui disparaît",
  goesAccount: "Votre nom, votre adresse, votre mode de connexion, votre avatar et vos connexions.",
  goesAlone_one: "{{count, number}} salle où vous êtes seul, avec son historique.",
  goesAlone_many: "{{count, number}} salles où vous êtes seul, avec leur historique.",
  goesAlone_other: "{{count, number}} salles où vous êtes seul, avec leur historique.",
  goesSeats_one: "Votre place dans {{count, number}} salle qui appartient à quelqu’un d’autre.",
  goesSeats_many: "Votre place dans {{count, number}} salles qui appartiennent à d’autres.",
  goesSeats_other: "Votre place dans {{count, number}} salles qui appartiennent à d’autres.",
  goesNames: "Votre nom sur vos cartes dans les tours nominatifs.",
  staysTitle: "Ce qui reste",
  staysCards:
    "Vos cartes des tours passés, sans nom et sans rien qui vous y relie, pour que les résultats de l’équipe tiennent.",
  staysWords:
    "Les mots saisis dans une salle qui continue : son nom, le sujet d’un tour, un ticket de sa file. Le serveur ne peut pas savoir lesquels parlent de vous.",
  staysCopies:
    "Ce que d’autres détiennent déjà : un export, une capture d’écran, leurs souvenirs. Cela leur appartient.",
  staysBackups:
    "Les sauvegardes de ce serveur conservent vos données jusqu’à leur expiration. La personne qui gère ce serveur doit vous supprimer à nouveau après une restauration.",
  staysLogs:
    "Les journaux du serveur contiennent des identifiants, jamais votre nom ni votre adresse, et vieillissent comme tout journal.",

  sharedTitle: "Salles où d’autres personnes sont présentes",
  sharedIntro:
    "Ces salles sont les vôtres, et d’autres personnes y ont une place. Choisissez qui reprend chacune : la salle et le droit de la supprimer vont à cette personne. Sans choix de votre part, la personne présente depuis le plus longtemps la reprend. Une salle ne disparaît que si vous le demandez.",
  sharedGuest_one:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} jour sans activité, elle est supprimée.",
  sharedGuest_many:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} jours sans activité, elle est supprimée.",
  sharedGuest_other:
    "Une salle reprise par un invité reste tant qu’elle sert : après {{count, number}} jours sans activité, elle est supprimée.",
  unnamed: "Salle sans nom",
  takerLabel: "Qui reprend {{name}}",
  takerDefault: "{{name}} (présence la plus ancienne)",
  takerDelete: "Personne : supprimer cette salle",
  deleteChosen:
    "Cette salle disparaît pour tous ses participants, avec son historique, dès que votre compte disparaît.",

  againBody:
    "Pour supprimer votre compte, vous devez vous être connecté il y a moins de 15 minutes : un navigateur resté ouvert ne doit pas pouvoir le faire. Vous revenez ensuite sur cette page.",
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

  nothingDeleted: "Rien n’a été supprimé, et vous êtes toujours connecté. Réessayez.",
  noAnswer:
    "Le serveur ne répond pas, et votre demande a pu lui parvenir ou non. Rechargez cette page une fois de retour en ligne.",

  doneTitle: "Votre compte est supprimé",
  doneBody:
    "Plus rien à votre nom ne reste sur ce serveur. Ce navigateur est désormais un nouvel invité, sans rien d’avant, et une nouvelle connexion crée un nouveau compte.",
  doneRemains:
    "Ce qui reste est ce que cette page annonçait : les sauvegardes jusqu’à leur expiration, les copies détenues par d’autres et les journaux qui contiennent des identifiants.",
  goingTitle: "Votre compte est en cours de suppression",
  goingBody:
    "Vous êtes déconnecté partout, et plus personne ne peut utiliser le compte. Une partie n’a pas encore disparu : cela se termine tout seul, en un jour au plus, et vous n’avez plus rien à faire. Une connexion avec ce compte le signale jusqu’à la fin.",
  lostTitle: "Vous êtes déconnecté",
  lostBody:
    "Le serveur n’a pas répondu à temps, et vous êtes déconnecté. C’est ainsi que commence une suppression : elle a très probablement abouti, et elle se termine toute seule. Si vous vous connectez et que votre compte est toujours là, rien n’a été supprimé.",
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
    "Laden Sie eine JSON-Datei mit dem herunter, was dieser Server über Sie speichert: Ihr Profil, Ihre Anmeldung, Ihre Räume, Ihre eigenen Karten in Runden mit Namen und Ihre Verbindungen. Sie enthält weder Namen noch Karten anderer Personen. Anonyme Runden fehlen darin: Dort verbindet Sie nichts mit einer Karte.",
  exportCodes:
    "Räume stehen darin mit Name und ID, nie mit ihrem Code: Ein Code öffnet einen Raum, und diese Datei kann weitergegeben werden.",
  exportAction: "Meine Daten herunterladen",
  exportBusy: "Ihre Datei wird vorbereitet…",
  exported: "Ihre Datei ist unterwegs.",
  exportIncomplete:
    "Ihre Datei ist unterwegs, aber einige Räume waren noch nicht in Ihrem Konto. Laden Sie sie gleich noch einmal herunter.",

  deleteTitle: "Mein Konto löschen",
  deleteIntro:
    "Das lässt sich nicht rückgängig machen. Sie werden zuerst überall abgemeldet, und danach kann niemand das Konto mehr nutzen.",
  goesTitle: "Was verschwindet",
  goesAccount: "Ihr Name, Ihre Adresse, Ihre Anmeldung, Ihr Avatar und Ihre Verbindungen.",
  goesAlone_one: "{{count, number}} Raum, in dem sonst niemand ist, mit seinem Verlauf.",
  goesAlone_other: "{{count, number}} Räume, in denen sonst niemand ist, mit ihrem Verlauf.",
  goesSeats_one: "Ihr Platz in {{count, number}} Raum, der jemand anderem gehört.",
  goesSeats_other: "Ihr Platz in {{count, number}} Räumen, die anderen gehören.",
  goesNames: "Ihr Name auf Ihren Karten in Runden mit Namen.",
  staysTitle: "Was bleibt",
  staysCards:
    "Ihre Karten aus vergangenen Runden, ohne Namen und ohne etwas, das sie mit Ihnen verbindet, damit die Ergebnisse des Teams stehen bleiben.",
  staysWords:
    "Was Sie in einem Raum getippt haben, der weiterbesteht: sein Name, das Thema einer Runde, ein Ticket in seiner Warteschlange. Der Server kann nicht wissen, was davon Sie nennt.",
  staysCopies:
    "Was andere bereits haben: einen Export, einen Screenshot, ihre Erinnerung. Das gehört ihnen.",
  staysBackups:
    "Sicherungen dieses Servers behalten Ihre Daten, bis sie ablaufen. Wer diesen Server betreibt, muss Sie nach einer Wiederherstellung erneut löschen.",
  staysLogs:
    "Server-Protokolle enthalten IDs, nie Ihren Namen oder Ihre Adresse, und altern wie alle Protokolle.",

  sharedTitle: "Räume mit anderen Personen",
  sharedIntro:
    "Diese Räume gehören Ihnen, und andere Personen haben dort einen Platz. Wählen Sie, wer jeden Raum übernimmt: Der Raum und das Recht, ihn zu löschen, gehen an diese Person. Ohne Wahl übernimmt die Person, die am längsten dabei ist. Ein Raum verschwindet nur, wenn Sie das sagen.",
  sharedGuest_one:
    "Ein Raum, den ein Gast übernimmt, bleibt, solange er genutzt wird: Nach {{count, number}} Tag ohne Aktivität wird er gelöscht.",
  sharedGuest_other:
    "Ein Raum, den ein Gast übernimmt, bleibt, solange er genutzt wird: Nach {{count, number}} Tagen ohne Aktivität wird er gelöscht.",
  unnamed: "Raum ohne Namen",
  takerLabel: "Wer übernimmt {{name}}",
  takerDefault: "{{name}} (am längsten dabei)",
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
    "Unter Ihrem Namen ist auf diesem Server nichts mehr vorhanden. Dieser Browser ist jetzt ein neuer Gast ohne alles von früher, und eine neue Anmeldung beginnt ein neues Konto.",
  doneRemains:
    "Was bleibt, ist, was diese Seite genannt hat: Sicherungen, bis sie ablaufen, Kopien anderer Personen und Protokolle mit IDs.",
  goingTitle: "Ihr Konto wird gelöscht",
  goingBody:
    "Sie sind überall abgemeldet, und niemand kann das Konto mehr nutzen. Ein Teil ist noch nicht verschwunden: Das erledigt sich von selbst, innerhalb eines Tages, und Sie müssen nichts mehr tun. Eine Anmeldung mit diesem Konto sagt das, bis es erledigt ist.",
  lostTitle: "Sie sind abgemeldet",
  lostBody:
    "Der Server hat nicht rechtzeitig geantwortet, und Sie sind abgemeldet. So beginnt eine Löschung: Sie ist sehr wahrscheinlich durchgegangen und erledigt sich von selbst. Wenn Sie sich anmelden und Ihr Konto noch da ist, wurde nichts gelöscht.",
  home: "Zurück zum Anfang",
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
