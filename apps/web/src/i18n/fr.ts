import type { Catalog } from "./en.ts";

// French copy, addressed with "vous" (OQ-2 default until #41). A narrow no-break space
// (U+202F) goes before : ; ! and ?, and plurals need `_many` (Intl.PluralRules gives
// "many" for 1 000 000 and up). Loaded on demand: see i18n.ts.
export const fr: Catalog<"many"> = {
  app: {
    name: "Poker Planning",
    tagline: "Le planning poker pour les équipes",
    skipToContent: "Aller au contenu",
  },
  theme: {
    current: "Thème : {{mode}}",
    label: "Thème",
    light: "Clair",
    dark: "Sombre",
    system: "Système",
  },
  language: {
    current: "Langue : {{language}}",
    label: "Langue",
    loadFailed: "Impossible de charger cette langue. Rechargez la page et réessayez.",
  },
  home: {
    title: "Estimez ensemble, autour d’une même table",
    lede: "Chacun choisit une carte, les cartes se retournent ensemble, puis l’équipe discute des écarts. Aucun compte requis.",
    createRoom: "Créer une salle",
    createRoomSoon: "La création de salles arrive dans la prochaine version.",
  },
  room: {
    title: "Salle {{code}}",
    codeLabel: "Code de la salle",
    notOpenYet:
      "Cette salle n’est pas encore ouverte : la table arrive dans une prochaine version.",
    backHome: "Retour à l’accueil",
  },
  table: {
    seats: "Personnes à la table",
    observers: "Observateurs",
    thinking: "Réfléchit",
    voted: "A voté",
    noVote: "Pas de vote",
    seatThinking: "{{name}}, réfléchit",
    seatVoted: "{{name}}, a voté",
    seatNoVote: "{{name}}, pas de vote",
    seatCard: "{{name}}, carte {{card}}",
    seatCardWord: "{{name}}, {{card}}",
    votedSoFar_one: "{{count, number}}/{{total, number}} a voté pour l’instant",
    votedSoFar_many: "{{count, number}}/{{total, number}} ont voté pour l’instant",
    votedSoFar_other: "{{count, number}}/{{total, number}} ont voté pour l’instant",
  },
  cards: {
    yourCards: "Vos cartes",
    unsure: "incertain",
    coffee: "besoin d’une pause",
    infinite: "trop gros pour être estimé",
  },
  dev: {
    tableTitle: "Disposition de la table",
    tableLede:
      "Un banc d’essai pour la table. Paramètres de l’adresse : n de 1 à 16, state lobby, voting ou revealed, observers de 0 à 4.",
    hand: "Main",
    miniCards: "Mini-cartes",
    average: "Moyenne des cartes numériques : {{value, number(maximumFractionDigits: 1)}}",
  },
  notFound: {
    title: "Page introuvable",
    body: "Cette adresse ne mène nulle part. Vérifiez le lien ou repartez de l’accueil.",
  },
  common: {
    close: "Fermer",
    notifications: "Notifications",
  },
  errors: {
    bad_command:
      "L’application a envoyé une demande que le serveur ne comprend pas. Rechargez la page et réessayez.",
    not_participant:
      "Vous ne faites plus partie de cette salle. Rechargez la page pour la rejoindre à nouveau.",
    not_owner: "Seul le product owner peut faire cela.",
    already_joined: "Vous êtes déjà dans cette salle.",
    bad_name:
      "Un nom compte de {{min, number}} à {{max, number}} caractères. Choisissez-en un autre.",
    bad_role: "Ce rôle n’existe pas. Choisissez votant ou observateur.",
    room_full: "Cette salle est complète. Demandez à quelqu’un de partir, puis réessayez.",
    cannot_kick_self: "Vous ne pouvez pas vous retirer vous-même. Quittez plutôt la salle.",
    unknown_participant: "Cette personne n’est plus dans la salle.",
    bad_subject: "Le sujet du tour n’est pas valide. Vérifiez le titre ou le lien et réessayez.",
    no_round: "Aucun tour n’est en cours. Lancez d’abord un tour.",
    not_voter: "Les observateurs ne votent pas. Passez au rôle de votant pour jouer une carte.",
    bad_card: "Cette carte ne fait pas partie du jeu de la salle. Choisissez-en une autre.",
    round_revealed: "Les cartes sont déjà retournées : les votes ne peuvent plus changer.",
    not_voting: "Ce tour n’est pas ouvert au vote.",
    not_allowed: "Les réglages de cette salle ne vous permettent pas de faire cela.",
    not_revealed: "Retournez d’abord les cartes.",
    bad_seconds:
      "Cette durée de minuteur n’est pas autorisée : un minuteur dure de {{min, number}} secondes à {{max, number}} minutes. Choisissez-en une autre.",
    no_timer: "Aucun minuteur n’est en cours.",
    target_not_present:
      "Cette personne n’est pas dans la salle en ce moment. Seule une personne présente peut devenir product owner.",
    already_owner: "Vous êtes déjà le product owner.",
    owner_present:
      "Le product owner est toujours là. Vous pourrez prendre le relais après deux minutes d’absence de sa part.",
    bad_settings: "Ces réglages ne sont pas valides. Vérifiez-les et réessayez.",
    deck_empty: "Un jeu doit contenir au moins une carte.",
    deck_too_many_cards:
      "Un jeu contient au plus {{max, number}} cartes. Retirez-en quelques-unes et réessayez.",
    card_empty: "Une carte ne peut pas être vide.",
    card_invalid:
      "Cette carte contient des caractères impossibles à afficher. Saisissez-la à nouveau.",
    card_too_long:
      "Le libellé d’une carte compte au plus {{max, number}} caractères. Raccourcissez-le.",
    card_duplicate: "Cette carte est déjà dans le jeu.",
    card_special:
      "Les cartes spéciales (?, ☕, ∞) s’activent dans les réglages de la salle, pas dans le jeu.",
    bad_payload: "Le serveur n’a pas pu lire cette demande. Rechargez la page et réessayez.",
    protocol_mismatch: "Une nouvelle version de l’application est disponible. Rechargez la page.",
    room_not_found:
      "Cette salle n’existe pas, ou elle a été supprimée après une longue période sans activité. Vérifiez le lien.",
    password_required: "Cette salle est protégée par un mot de passe. Saisissez-le pour entrer.",
    unauthenticated: "Votre session a expiré. Rechargez la page pour continuer.",
    rate_limited: "Trop de tentatives. Patientez un instant, puis réessayez.",
    internal: "Une erreur s’est produite sur le serveur. Réessayez dans un instant.",
    unknown: "Une erreur s’est produite. Réessayez ou rechargez la page.",
  },
};
