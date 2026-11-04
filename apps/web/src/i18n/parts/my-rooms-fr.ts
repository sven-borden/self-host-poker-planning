import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./my-rooms-en.ts";

// The words of “My rooms” (#49), in French. Loaded with its panel when the page speaks French: see
// copy-parts.ts.
export const copy: CatalogOf<typeof english, "many"> = {
  myRooms: {
    intro:
      "Les salles dont vous êtes propriétaire, et celles où vous avez une place en ce moment. Si vous quittez une salle ou en êtes retiré, elle disparaît de cette liste.",
    retention_one:
      "Vos salles restent jusqu’à ce que vous les supprimiez. Toute autre salle de cette liste peut disparaître après {{count, number}} jour sans activité.",
    retention_many:
      "Vos salles restent jusqu’à ce que vous les supprimiez. Toute autre salle de cette liste peut disparaître après {{count, number}} de jours sans activité.",
    retention_other:
      "Vos salles restent jusqu’à ce que vous les supprimiez. Toute autre salle de cette liste peut disparaître après {{count, number}} jours sans activité.",
    signedOut:
      "Connectez-vous pour voir les salles dont vous êtes propriétaire et celles où vous avez une place. Ce que vous avez fait en tant qu’invité vous suit.",
    loading: "Chargement de vos salles…",
    moving:
      "Certaines de vos salles sont encore en cours de transfert vers votre compte. Réessayez dans un instant.",
    emptyTitle: "Pas encore de salle",
    emptyBody: "Les salles que vous créez ou rejoignez une fois connecté apparaissent ici.",
    owned: "Votre salle",
    joined: "Vous avez une place",
    claimed: "Vous êtes product owner",
    claimedWhy:
      "Ce rôle vous permet d’animer cette salle et de la renommer. La supprimer reste réservé à la personne à qui elle appartient : reprendre le rôle ou le recevoir ne donne pas ce droit.",
    noKeeperWhy_one:
      "Ce rôle vous permet d’animer cette salle et de la renommer. Personne ne peut la supprimer : ce droit a disparu avec le compte qui le détenait. Elle disparaît après {{count, number}} jour sans activité.",
    noKeeperWhy_many:
      "Ce rôle vous permet d’animer cette salle et de la renommer. Personne ne peut la supprimer : ce droit a disparu avec le compte qui le détenait. Elle disparaît après {{count, number}} de jours sans activité.",
    noKeeperWhy_other:
      "Ce rôle vous permet d’animer cette salle et de la renommer. Personne ne peut la supprimer : ce droit a disparu avec le compte qui le détenait. Elle disparaît après {{count, number}} jours sans activité.",
    kept: "Votre salle, avec un autre product owner",
    keptWhy:
      "Quelqu’un d’autre a repris le rôle de product owner. Récupérez ce rôle dans la salle, et vous pourrez la supprimer.",
    signInAgain:
      "Certaines de vos salles demandent une connexion récente. Déconnectez-vous, puis reconnectez-vous pour les voir.",
    rounds_one: "{{count, number}} tour",
    rounds_many: "{{count, number}} de tours",
    rounds_other: "{{count, number}} tours",
    showMore: "Afficher plus de salles",
    cancel: "Annuler",
    rename: "Renommer",
    renameNamed: "Renommer {{name}}",
    renameTitle: "Renommer cette salle",
    nameLabel: "Nom de la salle",
    save: "Enregistrer",
    renamed: "Salle renommée.",
    delete: "Supprimer",
    deleteNamed: "Supprimer {{name}}",
    deleteTitle: "Supprimer {{name}} ?",
    deleteBody:
      "La salle disparaît pour tout le monde : ses tours, son historique, sa file et les accès. C’est définitif.",
    deleteLive: "Les personnes présentes dans la salle voient aussitôt qu’elle n’existe plus.",
    deleteConfirm: "Supprimer cette salle",
    deleted: "Salle supprimée.",
    leave: "Quitter cette salle",
    leaveNamed: "Quitter cette salle : {{name}}",
    leaveTitle: "Quitter {{name}} ?",
    leaveBody:
      "Vous perdez votre place et la salle disparaît de cette liste. Le lien de la salle vous permet de la rejoindre à nouveau.",
    leaveKept:
      "Vous perdez votre place. La salle reste dans cette liste, car elle est toujours à vous.",
    left: "Vous avez quitté la salle.",
    gone: "Cette salle n’existe plus.",
  },
};
