/**
 * What the web app and the server share about an account's own page (#51, ADR-029).
 *
 * Deleting an account takes one typed word, in the language of the page. The server takes any of
 * the three, as it does not know which the page showed; the point is a deliberate act, and it
 * checks that itself: the page's dialog is not the guard.
 */
export const ACCOUNT_DELETE_WORDS = { en: "DELETE", fr: "SUPPRIMER", de: "LÖSCHEN" } as const;

/** Whether `typed` is the word, whatever its case and the spaces around it. */
export function isAccountDeleteWord(typed: string): boolean {
  const word = typed.normalize("NFC").trim().toUpperCase();
  return Object.values<string>(ACCOUNT_DELETE_WORDS).includes(word);
}

/** The shape of the export file: raised when a field changes its meaning or goes. */
export const ACCOUNT_EXPORT_VERSION = 1;
