import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./my-rooms-en.ts";

// The words of “My rooms” (#49), in German. Loaded with its panel when the page speaks German: see
// copy-parts.ts.
export const copy: CatalogOf<typeof english> = {
  myRooms: {
    intro:
      "Die Räume, die Ihnen gehören, und die Räume, in denen Sie gerade einen Platz haben. Wenn Sie einen Raum verlassen oder daraus entfernt werden, verschwindet er aus dieser Liste.",
    retention_one:
      "Ihre eigenen Räume bleiben, bis Sie sie löschen. Jeder andere Raum in dieser Liste kann nach {{count, number}} Tag ohne Aktivität verschwinden.",
    retention_other:
      "Ihre eigenen Räume bleiben, bis Sie sie löschen. Jeder andere Raum in dieser Liste kann nach {{count, number}} Tagen ohne Aktivität verschwinden.",
    signedOut:
      "Melden Sie sich an, um die Räume zu sehen, die Ihnen gehören und in denen Sie einen Platz haben. Was Sie als Gast getan haben, kommt mit.",
    loading: "Ihre Räume werden geladen…",
    moving:
      "Einige Ihrer Räume werden noch in Ihr Konto übertragen. Versuchen Sie es gleich noch einmal.",
    emptyTitle: "Noch keine Räume",
    emptyBody: "Räume, die Sie angemeldet erstellen oder betreten, erscheinen hier.",
    owned: "Ihr Raum",
    joined: "Sie haben einen Platz",
    claimed: "Sie sind Product Owner",
    claimedWhy:
      "Mit dieser Rolle leiten Sie den Raum und können ihn umbenennen. Löschen kann ihn nur die Person, der er gehört: Die Rolle zu übernehmen oder übergeben zu bekommen, gibt dieses Recht nicht.",
    noKeeperWhy_one:
      "Mit dieser Rolle leiten Sie den Raum und können ihn umbenennen. Löschen kann ihn niemand: Das Recht dazu ist mit dem Konto verschwunden, das es hielt. Er verschwindet nach {{count, number}} Tag ohne Aktivität.",
    noKeeperWhy_other:
      "Mit dieser Rolle leiten Sie den Raum und können ihn umbenennen. Löschen kann ihn niemand: Das Recht dazu ist mit dem Konto verschwunden, das es hielt. Er verschwindet nach {{count, number}} Tagen ohne Aktivität.",
    kept: "Ihr Raum, mit einem anderen Product Owner",
    keptWhy:
      "Jemand anderes hat die Rolle des Product Owners übernommen. Holen Sie sich die Rolle im Raum zurück, dann können Sie ihn löschen.",
    signInAgain:
      "Einige Ihrer Räume verlangen eine aktuelle Anmeldung. Melden Sie sich ab und wieder an, um sie zu sehen.",
    rounds_one: "{{count, number}} Runde",
    rounds_other: "{{count, number}} Runden",
    showMore: "Mehr Räume anzeigen",
    cancel: "Abbrechen",
    rename: "Umbenennen",
    renameNamed: "{{name}} umbenennen",
    renameTitle: "Diesen Raum umbenennen",
    nameLabel: "Raumname",
    save: "Speichern",
    renamed: "Raum umbenannt.",
    delete: "Löschen",
    deleteNamed: "{{name}} löschen",
    deleteTitle: "{{name}} löschen?",
    deleteBody:
      "Der Raum verschwindet für alle: seine Runden, sein Verlauf, seine Warteschlange und alle Zugänge. Das lässt sich nicht rückgängig machen.",
    deleteLive: "Wer gerade im Raum ist, sieht sofort, dass er nicht mehr da ist.",
    deleteConfirm: "Diesen Raum löschen",
    deleted: "Raum gelöscht.",
    leave: "Diesen Raum verlassen",
    leaveNamed: "Diesen Raum verlassen: {{name}}",
    leaveTitle: "{{name}} verlassen?",
    leaveBody:
      "Ihr Platz wird frei, und der Raum verschwindet aus dieser Liste. Über den Link des Raums können Sie wieder beitreten.",
    leaveKept:
      "Ihr Platz wird frei. Der Raum bleibt in dieser Liste, weil er weiterhin Ihnen gehört.",
    left: "Sie haben den Raum verlassen.",
    gone: "Diesen Raum gibt es nicht mehr.",
  },
};
