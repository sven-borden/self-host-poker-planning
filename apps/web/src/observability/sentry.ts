/**
 * The Sentry chunk (#40), imported by `errors.ts` only when the page carries a DSN. The
 * SDK with three integrations: uncaught errors and unhandled rejections, an error's
 * causes, and no repeats. No breadcrumbs (they would hold addresses and clicks), no
 * sessions, no tracing, no replay. An event's request is the page's route, never its
 * address, and the browser; every string passes `hideRoomCodesIn`, with the code of the
 * room on screen.
 */
import { hideRoomCodes, hideRoomCodesIn, isRoomCode } from "@pp/domain";
import {
  captureException,
  dedupeIntegration,
  type ErrorEvent,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
} from "@sentry/browser";

export interface SentryOptions {
  dsn: string;
  /** The commit the server runs, from the `<meta>`'s `data-release`. */
  release: string | undefined;
}

export function startSentry({ dsn, release }: SentryOptions): (error: unknown) => void {
  init({
    dsn,
    release,
    defaultIntegrations: false,
    integrations: [globalHandlersIntegration(), linkedErrorsIntegration(), dedupeIntegration()],
    // Nothing about the person: no user, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sendClientReports: false,
    beforeSend: (event) => scrub(event),
  });
  return (error) => {
    captureException(error);
  };
}

/** The code of the room in `pathname` (`/r/:code`), when it has one. */
export function roomCodeOf(pathname: string): string | undefined {
  const segment = /^\/r\/+([^/]+)/i.exec(pathname)?.[1];
  if (!segment) return undefined;
  let code = segment;
  try {
    code = decodeURIComponent(segment);
  } catch {
    // A stray `%`: the segment as it stands.
  }
  return isRoomCode(code) ? code : undefined;
}

/** What leaves for Sentry: the route instead of the address, no user, no breadcrumbs. */
export function scrub(
  event: ErrorEvent,
  where: Pick<Location, "origin" | "pathname"> = location,
  userAgent = navigator.userAgent,
): ErrorEvent {
  const code = roomCodeOf(where.pathname);
  const codes = code ? [code] : [];
  const { breadcrumbs: _, user: __, ...rest } = event;
  return hideRoomCodesIn(
    {
      ...rest,
      request: {
        url: `${where.origin}${hideRoomCodes(where.pathname, codes)}`,
        headers: { "User-Agent": userAgent },
      },
    },
    codes,
  );
}
