import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./queue-en.ts";

// The queue sheet's words (#52, #54, #55): the queue and the Jira and Azure DevOps sections in it,
// in French. Loaded with its panel when the page speaks French: see copy-parts.ts.
export const copy: CatalogOf<typeof english, "many"> = {
  queue: {
    lede: "Ce que l’équipe estime ensuite, dans l’ordre. Cette liste n’est visible que par vous\u{202f}; la salle voit ce qui vient ensuite.",
    pasteLabel: "Collez vos tickets",
    pasteHint:
      "Un par ligne : des clés, des liens, ou un tableau copié depuis Jira ou Azure DevOps. Toute autre ligne devient un titre. Aucun lien n’est ouvert.",
    add: "Ajouter à la file",
    nothingPasted: "Collez d’abord une liste.",
    added_one: "{{count, number}} ticket ajouté.",
    added_many: "{{count, number}} de tickets ajoutés.",
    added_other: "{{count, number}} tickets ajoutés.",
    addedNone: "Rien de nouveau à ajouter.",
    duplicates_one: "{{count, number}} doublon retiré.",
    duplicates_many: "{{count, number}} de doublons retirés.",
    duplicates_other: "{{count, number}} doublons retirés.",
    refused_one: "{{count, number}} ligne n’a pas pu être lue.",
    refused_many: "{{count, number}} de lignes n’ont pas pu être lues.",
    refused_other: "{{count, number}} lignes n’ont pas pu être lues.",
    shortened_one: "{{count, number}} titre a été raccourci.",
    shortened_many: "{{count, number}} de titres ont été raccourcis.",
    shortened_other: "{{count, number}} titres ont été raccourcis.",
    kept: "Ces lignes restent dans le champ.",
    partial_one:
      "{{count, number}} ticket a été ajouté avant l’interruption. Le reste est encore dans le champ\u{202f}: ajoutez-le de nouveau, rien ne sera ajouté deux fois.",
    partial_many:
      "{{count, number}} de tickets ont été ajoutés avant l’interruption. Le reste est encore dans le champ\u{202f}: ajoutez-le de nouveau, rien ne sera ajouté deux fois.",
    partial_other:
      "{{count, number}} tickets ont été ajoutés avant l’interruption. Le reste est encore dans le champ\u{202f}: ajoutez-le de nouveau, rien ne sera ajouté deux fois.",
    empty: "La file est encore vide.",
    loading: "Chargement de la file…",
    retry: "Réessayer",
    list: "Tickets de la file",
    moveUp: "Monter {{item}}",
    moveDown: "Descendre {{item}}",
    remove: "Retirer {{item}}",
    moved: "{{item}} est maintenant en position {{place, number}} sur {{total, number}}.",
    removed: "{{item}} retiré.",
    clear: "Vider la file",
    clearAsk_one: "Retirer {{count, number}} ticket ?",
    clearAsk_many: "Retirer les {{count, number}} de tickets ?",
    clearAsk_other: "Retirer les {{count, number}} tickets ?",
    clearYes: "Tout retirer",
    clearNo: "Les garder",
    cleared: "La file est vide.",
  },
  connector: {
    connect: "Connecter {{system}}",
    lede: "Importez un sprint ou une recherche dans la file, et renvoyez les estimations. Vous connectez votre propre compte, et personne d’autre dans la salle ne s’en sert.",
    signIn: "Connectez-vous avec un compte pour pouvoir connecter {{system}}.",
    connectedTo: "Connecté à {{site}}",
    site: "Site",
    siteSave: "Utiliser ce site",
    siteChange: "Changer de site",
    field: "Les estimations vont dans",
    fieldIs: "Les estimations vont dans {{field}}",
    fieldHint:
      "Un champ numérique de ce site. La suggestion se fonde sur son nom : vérifiez-la avant d’enregistrer.",
    fieldSave: "Enregistrer le champ",
    fieldChange: "Changer de champ",
    fieldNone: "Ce site n’a aucun champ numérique : les estimations ne peuvent pas y retourner.",
    importFrom: "Importer depuis",
    bySprint: "Un sprint",
    byJql: "Une recherche JQL",
    board: "Tableau",
    boardFilter: "Nom du tableau",
    boardFind: "Chercher",
    noBoards: "Aucun tableau trouvé.",
    noSites: "Ce compte n’accède à aucun site {{system}}.",
    sprint: "Sprint",
    sprintActive: "{{sprint}} (actif)",
    noSprints: "Ce tableau n’a aucun sprint actif ou à venir.",
    jql: "Requête JQL",
    jqlHint:
      "Telle que vous la saisiriez dans la recherche de tickets. Elle part vers Jira et n’est pas conservée ici.",
    import: "Importer",
    importing: "Importation…",
    nothingAsked: "Choisissez d’abord un sprint ou saisissez une requête.",
    leftOut_one:
      "{{count, number}} ticket laissé de côté : la file est pleine ou il n’a pas pu être lu.",
    leftOut_many:
      "{{count, number}} de tickets laissés de côté : la file est pleine ou ils n’ont pas pu être lus.",
    leftOut_other:
      "{{count, number}} tickets laissés de côté : la file est pleine ou ils n’ont pas pu être lus.",
    beyond_one: "Environ {{count, number}} autre au-delà de la limite de {{max, number}} tickets.",
    beyond_many:
      "Environ {{count, number}} d’autres au-delà de la limite de {{max, number}} tickets.",
    beyond_other:
      "Environ {{count, number}} autres au-delà de la limite de {{max, number}} tickets.",
    beyondUnknown: "D’autres tickets restent au-delà de la limite de {{max, number}}.",
    disconnect: "Déconnecter",
    disconnectNote:
      "Cela supprime votre jeton ici. {{system}} garde sa propre trace de l’autorisation :",
    grantsLink: "retirez-la dans votre compte Atlassian",
    result: {
      expired:
        "Cela a pris trop de temps, {{system}} n’a pas été connecté. Connectez-le de nouveau.",
      failed: "{{system}} n’a pas pu être connecté. Réessayez.",
    },
    azure: {
      lede: "Importez une requête enregistrée ou une requête WIQL dans la file, et renvoyez les estimations. Vous vous connectez avec votre propre jeton, et personne d’autre dans la salle ne s’en sert.",
      organization: "Organisation",
      organizationHint:
        "Son nom seul\u{202f}: ce qui suit dev.azure.com/ dans votre barre d’adresse.",
      token: "Jeton d’accès personnel",
      tokenScope:
        "Créez-en un pour cette seule organisation, avec une seule autorisation cochée\u{202f}: Work Items, Read & write.",
      tokenLink: "Créer un jeton",
      tokenUse:
        "Il sert uniquement à lire ce que vous importez et à écrire vos estimations. Chez Microsoft, il cesse de fonctionner à sa date d’expiration\u{202f}: donnez-lui la durée la plus courte qui vous convient. Ici, il reste chiffré jusqu’à ce que vous déconnectiez Azure DevOps, en colliez un autre ou supprimiez votre compte.",
      tokenReplace: "Utiliser ce jeton",
      checking: "Vérification du jeton…",
      project: "Projet",
      projectIs: "Projet\u{202f}: {{project}}",
      projectSave: "Utiliser ce projet",
      projectChange: "Changer de projet",
      noProjects: "Ce jeton n’atteint aucun projet dans cette organisation.",
      fieldAuto:
        "Les estimations vont dans le champ que porte le type de chaque élément\u{202f}: Story Points, Effort ou Size.",
      fieldPick: "Choisir un champ",
      fieldReset: "Utiliser le champ de chaque type",
      fieldType: "Type d’élément de travail",
      fieldHint:
        "Les éléments d’un type sans ce champ s’en tiennent à Story Points, Effort ou Size.",
      fieldNone: "Ce type n’a aucun champ numérique.",
      fieldCancel: "Annuler",
      bySaved: "Une requête enregistrée",
      byWiql: "Une requête WIQL",
      saved: "Requête enregistrée",
      noSaved: "Ce projet n’a aucune requête enregistrée visible pour vous.",
      savedMore: "Certains dossiers n’ont pas été lus\u{202f}: cette liste n’est pas complète.",
      wiql: "Requête WIQL",
      wiqlHint:
        "Par exemple\u{202f}: Select [System.Id] From WorkItems Where [System.TeamProject] = @project. Elle part vers Azure DevOps et n’est pas conservée ici.",
      nothingAsked: "Choisissez d’abord une requête enregistrée ou saisissez une requête.",
      disconnectNote:
        "Cela supprime votre jeton ici. Il existe toujours chez Microsoft jusqu’à son expiration ou sa révocation\u{202f}:",
      revokeLink: "le révoquer dans Azure DevOps",
    },
  },
};
