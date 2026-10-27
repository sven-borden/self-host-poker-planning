import {
  MAX_CARD_LENGTH,
  MAX_DECK_CARDS,
  MAX_NAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
} from "@pp/domain";
import type { AckErrorCode } from "@pp/protocol";
import { en } from "./en.ts";
import type { MessageKey, Params, TFunction } from "./i18n.ts";

// The server answers with codes, never sentences (ADR-012). Every code `@pp/protocol`
// lists has a message in every language; i18n.test.ts enumerates them. Messages that
// state a limit take it from the domain's constants, so the copy cannot drift from the
// rule, and `t` formats it for the reader's region.

type Code = AckErrorCode & string;
type Key<C extends Code> = `errors.${C}` & MessageKey;
type CodesWithValues = {
  [C in Code]: keyof Params<Key<C>> extends never ? never : C;
}[Code];

/** The values each limit-stating message needs; tsc fails when one is missing or wrong. */
export const ERROR_VALUES: { [C in CodesWithValues]: Params<Key<C>> } = {
  bad_name: { min: 1, max: MAX_NAME_LENGTH },
  bad_room_name: { min: 1, max: MAX_ROOM_NAME_LENGTH },
  bad_seconds: { min: MIN_TIMER_SECONDS, max: MAX_TIMER_SECONDS / 60 },
  deck_too_many_cards: { max: MAX_DECK_CARDS },
  card_too_long: { max: MAX_CARD_LENGTH },
};

/** True for a code this version has a message for. */
export function isKnownErrorCode(code: string): code is AckErrorCode {
  return code !== "unknown" && Object.hasOwn(en.errors, code);
}

/** The message for a server error code, or a generic one for a code this version does not know. */
export function errorMessage(t: TFunction, code: string): string {
  if (!isKnownErrorCode(code)) {
    return t("errors.unknown");
  }
  const values: object | undefined = Object.hasOwn(ERROR_VALUES, code)
    ? ERROR_VALUES[code as CodesWithValues]
    : undefined;
  // The key is only known at run time; ERROR_VALUES above is what tsc checks.
  return (t as (key: string, values?: object) => string)(`errors.${code}`, values);
}
