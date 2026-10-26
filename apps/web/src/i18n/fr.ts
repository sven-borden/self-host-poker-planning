import type { Messages } from "./en.ts";

// French copy, addressed with "vous" (OQ-2 default until #41).
export const fr: Messages = {
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
  notFound: {
    title: "Page introuvable",
    body: "Cette adresse ne mène nulle part. Vérifiez le lien ou repartez de l’accueil.",
  },
  common: {
    close: "Fermer",
    notifications: "Notifications",
  },
};
