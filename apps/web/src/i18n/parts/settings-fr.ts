import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./settings-en.ts";

// The room settings panel's words (#25 to #31, #50): the panel, the deck field, the rule and the
// password rows, in French. Loaded with its panel when the page speaks French: see copy-parts.ts.
export const copy: CatalogOf<typeof english, "many"> = {
  settings: {
    ledeOwner: "Chaque changement s’applique à toute la salle en même temps.",
    ledeOthers:
      "Le product owner décide du déroulement de cette salle. Voici les réglages actuels.",
    groupCards: "Cartes",
    groupRound: "Vote et révélation",
    groupPeople: "Participants",
    on: "Activé",
    off: "Désactivé",
    saving: "Enregistrement…",
    connectionDropped: "Non enregistré\u{202f}: connexion perdue.",
    deck: "Jeu de cartes",
    deckHint: "Les cartes parmi lesquelles chacun choisit.",
    specials: "Cartes spéciales",
    specialsHint:
      "Des cartes pour dire que vous hésitez, qu’il faut une pause ou que le sujet est trop gros pour être estimé. Elles ne comptent jamais dans les résultats.",
    specialsNone: "Aucune",
    timer: "Minuteur pour chaque tour",
    timerHint:
      "Chaque tour démarre avec ce compte à rebours. Un changement s’applique dès le tour suivant.",
    timerThenReveal: "À la fin, les cartes se retournent.",
    timerThenTimeUp: "À la fin, tout le monde voit que le temps est écoulé.",
    timerCustom: "Autre durée",
    timerCustomLabel: "Durée personnalisée",
    timerSet: "Valider",
    timerRevealAtEnd: "Révéler à la fin du minuteur",
    timerRevealAtEndHint:
      "Si c’est désactivé, tout le monde voit que le temps est écoulé et le product owner révèle les cartes.",
    whoCanReveal: "Qui peut révéler",
    whoCanRevealHint: "Qui peut révéler les cartes. Jamais les observateurs.",
    revealByOwner: "Le product owner",
    revealByAnyone: "Toute personne qui vote",
    anonymous: "Vote anonyme",
    anonymousHint:
      "Les résultats montrent les cartes sans les noms. Un changement s’applique à partir du tour suivant.",
    roundStaysNamed: "Ce tour montre encore les noms.",
    roundStaysAnonymous: "Ce tour reste anonyme.",
    revealWhenAllVotedNow: "Tout le monde a voté\u{202f}: l’activer révèle les cartes.",
    revealWhenAllVoted: "Révéler quand tout le monde a voté",
    revealWhenAllVotedHint:
      "Les cartes se retournent d’elles-mêmes dès que toutes les personnes présentes ont voté.",
    changeAfterReveal: "Changer son vote après la révélation",
    changeAfterRevealHint:
      "Les votants peuvent encore changer de carte après la révélation. Jamais dans un tour anonyme\u{202f}: ses votes sont définitifs une fois révélés.",
    changeAfterRevealLocked: "Les tours anonymes figent leurs votes à la révélation.",
    allowed: "Autorisé",
    notAllowed: "Non autorisé",
    autoAdvance: "Passer automatiquement au ticket suivant",
    autoAdvanceHint:
      "{{seconds, number}} secondes après l’enregistrement d’une estimation, le ticket suivant de la file démarre. Tout le monde voit le décompte, et le product owner peut rester sur ce tour.",
    poVotes: "Le product owner vote aussi",
    poVotesHint: "Désactivé, le product owner anime la séance sans cartes.",
    observersCount: "Les observateurs occupent l’une des {{max, number}} places",
    observersCountHint:
      "Désactivé, les observateurs peuvent rejoindre une salle complète, jusqu’à {{total, number}} personnes en tout.",
    observersCountRefused:
      "Plus de {{max, number}} personnes sont là en comptant les observateurs. Ils compteront de nouveau dès que {{max, number}} personnes ou moins seront là.",
    restriction: "Qui peut rejoindre",
    restrictionHint:
      "Réservez cette salle à certains comptes. Toute personne qui a le lien voit les domaines autorisés, pour choisir le bon compte.",
    restrictionAnyone: "Toute personne ayant le lien",
    restrictionLimited: "Limité",
  },
  deckField: {
    inUse: "Utilisé",
    use: "Utiliser {{deck}}",
    customLabel: "Cartes, séparées par des virgules",
    customHint:
      "Jusqu’à {{max, number}} cartes de {{length, number}} caractères au plus, emoji compris. La virgule sépare les cartes\u{202f}: écrivez un nombre décimal avec un point, comme 0.5.",
    customCount_one: "{{count, number}} carte",
    customCount_many: "{{count, number}} de cartes",
    customCount_other: "{{count, number}} cartes",
    useCustom: "Utiliser ces cartes",
    fromNextRound: "Les nouvelles cartes s’appliquent à partir du tour {{round, number}}.",
    restartsRound:
      "Les nouvelles cartes relancent le tour {{round, number}}\u{202f}: ses votes sont effacés, son sujet reste.",
    deckQuestion_one:
      "Changer de jeu relance le tour {{round, number}}. Le vote déjà exprimé est effacé\u{202f}; le sujet reste.",
    deckQuestion_many:
      "Changer de jeu relance le tour {{round, number}}. Les {{count, number}} de votes déjà exprimés sont effacés\u{202f}; le sujet reste.",
    deckQuestion_other:
      "Changer de jeu relance le tour {{round, number}}. Les {{count, number}} votes déjà exprimés sont effacés\u{202f}; le sujet reste.",
    specialsQuestion_one:
      "Changer les cartes spéciales relance le tour {{round, number}}. Le vote déjà exprimé est effacé\u{202f}; le sujet reste.",
    specialsQuestion_many:
      "Changer les cartes spéciales relance le tour {{round, number}}. Les {{count, number}} de votes déjà exprimés sont effacés\u{202f}; le sujet reste.",
    specialsQuestion_other:
      "Changer les cartes spéciales relance le tour {{round, number}}. Les {{count, number}} votes déjà exprimés sont effacés\u{202f}; le sujet reste.",
    restartWith: "Relancer avec {{deck}}",
    restartSpecials: "Relancer avec les nouvelles cartes spéciales",
    cancel: "Annuler",
    deck_empty: "Saisissez au moins une carte.",
    deck_too_many_cards:
      "Cela fait {{count, number}} cartes\u{202f}; un jeu en compte {{max, number}} au plus.",
    card_empty: "La carte {{position, number}} est vide. Retirez la virgule en trop.",
    card_invalid:
      "La carte {{position, number}} contient des caractères impossibles à afficher. Saisissez-la de nouveau.",
    card_too_long:
      "«\u{202f}{{card}}\u{202f}» est trop long\u{202f}: une carte compte {{max, number}} caractères au plus.",
    card_duplicate: "«\u{202f}{{card}}\u{202f}» figure deux fois dans le jeu. Gardez-en une.",
    card_same_value:
      "«\u{202f}{{card}}\u{202f}» a la même valeur que «\u{202f}{{other}}\u{202f}». Gardez l’une des deux.",
    card_special:
      "«\u{202f}{{card}}\u{202f}» est une carte spéciale. Activez-la sous «\u{202f}Cartes spéciales\u{202f}» au lieu de la saisir.",
    rangeOpen: "Générer une suite",
    rangeStart: "Début",
    rangeEnd: "Fin",
    rangeStep: "Pas",
    rangeHint:
      "Des nombres, avec une virgule ou un point pour les décimales. Les cartes remplissent le champ ci-dessus, où vous pouvez encore les modifier.",
    rangeFill: "Remplir les cartes",
    rangeFilled_one: "{{count, number}} carte ajoutée. Vérifiez-la, puis utilisez-la.",
    rangeFilled_many: "{{count, number}} de cartes ajoutées. Vérifiez-les, puis utilisez-les.",
    rangeFilled_other: "{{count, number}} cartes ajoutées. Vérifiez-les, puis utilisez-les.",
    range_not_finite: "Saisissez un nombre pour le début, la fin et le pas, comme 0,5 ou 0.5.",
    range_step_not_positive: "Le pas doit être supérieur à 0.",
    range_end_before_start: "La fin ne doit pas être inférieure au début.",
    range_too_many_cards:
      "Cette suite donne plus de {{max, number}} cartes. Prenez un pas plus grand ou une suite plus courte.",
    range_label_too_long:
      "Certaines valeurs demanderaient plus de {{max, number}} caractères, comme 0,125 ou 10000. Utilisez moins de décimales ou des nombres plus petits.",
    specialUnsure: "Pas sûr",
    specialCoffee: "Besoin d’une pause",
    specialInfinite: "Trop gros pour être estimé",
  },
  restriction: {
    yourOrganisation: "votre organisation",
    signInFirst: "Connectez-vous pour réserver cette salle à certains comptes.",
    domainsLabel: "Domaines de messagerie",
    domainsHint:
      "Un par ligne, à l’identique : example.com n’admet pas mail.example.com. Seul compte un compte Google dont Google a vérifié l’adresse, et cela prouve seulement que quelqu’un a pu y recevoir du courrier, boîtes partagées comprises.",
    tenantsLabel: "ID de locataire Microsoft",
    tenantsHint:
      "Un par ligne. Les personnes connectées avec Microsoft entrent par l’ID de locataire de leur organisation, jamais par leur adresse\u{202f}: un domaine ci-dessus ne les admet pas.",
    googleGone:
      "Ce serveur ne propose plus la connexion Google\u{202f}: plus personne ne peut entrer par un domaine.",
    microsoftGone:
      "Ce serveur ne propose plus la connexion Microsoft\u{202f}: plus personne ne peut entrer par un ID de locataire.",
    badDomain: "Ce n’est pas un domaine : {{entry}}",
    badTenant: "Ce n’est pas l’ID de locataire d’une organisation\u{202f}: {{entry}}",
    tooMany: "Chaque liste contient {{max, number}} entrées au plus.",
    outsiders_one:
      "{{count, number}} personne ici ne serait pas admise. Elle reste jusqu’à ce qu’elle recharge la page, perde sa connexion ou s’en aille.",
    outsiders_many:
      "{{count, number}} de personnes ici ne seraient pas admises. Elles restent jusqu’à ce qu’elles rechargent la page, perdent leur connexion ou s’en aillent.",
    outsiders_other:
      "{{count, number}} personnes ici ne seraient pas admises. Elles restent jusqu’à ce qu’elles rechargent la page, perdent leur connexion ou s’en aillent.",
    askFirst:
      "Vous ne respectez pas vous-même cette règle. Vous restez tant que vous êtes le product owner, mais vous ne pourriez pas revenir après avoir confié le rôle.",
    removeOutsiders: "Retirer toutes les personnes qui ne seraient pas admises",
    removeAsk_one:
      "{{count, number}} personne quitte la salle maintenant, et ne pourra revenir qu’avec un compte admis par la règle.",
    removeAsk_many:
      "{{count, number}} de personnes quittent la salle maintenant, et ne pourront revenir qu’avec un compte admis par la règle.",
    removeAsk_other:
      "{{count, number}} personnes quittent la salle maintenant, et ne pourront revenir qu’avec un compte admis par la règle.",
    removeConfirm: "Les retirer",
    askConfirm: "Enregistrer quand même",
    save: "Enregistrer la règle",
    remove: "Retirer la règle",
  },
  password: {
    settingHint:
      "Les personnes déjà dans la salle y restent. Les autres le saisissent une fois sur chaque appareil.",
    set: "Définir le mot de passe",
    save: "Enregistrer le mot de passe",
    change: "Changer le mot de passe",
    remove: "Supprimer le mot de passe",
    cancel: "Annuler",
  },
};
