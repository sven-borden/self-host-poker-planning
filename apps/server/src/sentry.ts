/**
 * The server's error reports to Sentry (#40, architecture section 11), imported by `run()`
 * only when `SENTRY_DSN` is set. A report is a log line: every line at `error` or `fatal`,
 * as pino wrote it, so it carries exactly what the log may carry (no room code, no secret,
 * the redact list applied). The request log's 5xx line (`REQUEST_FAILED`) is left out:
 * its cause has a line of its own, and a database outage would otherwise report every
 * health check. A line's `err` becomes the exception, with the frames of its stack; its
 * message and its other fields go along.
 *
 * Only `@sentry/core`: `@sentry/node` brings OpenTelemetry and build tools, about 30 MB in
 * the image, for tracing this app does not do. No breadcrumbs, no request data, no host
 * name; every string passes `hideRoomCodes` on the way out as a second line of defence.
 */
import { hideRoomCodesIn } from "@pp/domain";
import {
  createStackParser,
  createTransport,
  dedupeIntegration,
  type ErrorEvent,
  type SeverityLevel,
  type TransportMakeRequestResponse,
  type TransportRequest,
} from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";
import { REQUEST_FAILED } from "./logger.ts";

/** Sends one envelope; `fetch` unless a test passes its own. */
export type SendEnvelope = (
  url: string,
  request: TransportRequest,
  headers: Record<string, string> | undefined,
) => Promise<TransportMakeRequestResponse>;

export interface ReportsOptions {
  dsn: string;
  /** The commit or version the server runs (`GIT_COMMIT`, else `APP_VERSION`). */
  release: string | undefined;
  send?: SendEnvelope;
}

export interface Reports {
  /** Takes every log line pino writes; reports those at `error` and `fatal`. Never throws. */
  write(line: string): void;
  /** Waits up to `timeoutMs` for the reports on their way; false when some did not go. */
  flush(timeoutMs: number): Promise<boolean>;
}

/** How long a report may take before the transport gives up on it. */
const SEND_TIMEOUT_MS = 5000;

/** pino writes `level` first: a line at `error` (50) or `fatal` (60) starts like this. */
const REPORTED_LINE = /^\{"level":(?:50|60),/;

/** Fields of a pino line that are not the reported context. */
const NOT_CONTEXT = new Set(["level", "time", "pid", "hostname", "msg", "err"]);

const sendWithFetch: SendEnvelope = async (url, request, headers) => {
  const response = await fetch(url, {
    method: "POST",
    body: request.body,
    headers,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return {
    statusCode: response.status,
    headers: {
      "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
      "retry-after": response.headers.get("retry-after"),
    },
  };
};

export function startReports({ dsn, release, send = sendWithFetch }: ReportsOptions): Reports {
  const client = new ServerRuntimeClient({
    dsn,
    release,
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [dedupeIntegration()],
    transport: (options) =>
      createTransport(options, (request) => send(options.url, request, options.headers)),
    // Nothing about the person: no user, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sendClientReports: false,
    traceLifecycle: "static",
    beforeSend: (event: ErrorEvent) => {
      delete event.server_name;
      delete event.breadcrumbs;
      return hideRoomCodesIn(event);
    },
  });
  client.init();

  const report = (line: string) => {
    const { msg, err, level, ...rest } = JSON.parse(line) as Record<string, unknown>;
    const message = typeof msg === "string" ? msg : "";
    if (message === REQUEST_FAILED) return;
    const extra = Object.fromEntries(Object.entries(rest).filter(([key]) => !NOT_CONTEXT.has(key)));
    const severity: SeverityLevel = level === 60 ? "fatal" : "error";
    const errorLike = typeof err === "object" && err !== null && "message" in err;
    // Something thrown that is not an error (`throw "boom"`) stays in the context.
    const context = { ...extra, ...(err !== undefined && !errorLike && { err }), msg: message };
    const hint = { captureContext: { level: severity, extra: context } };
    if (errorLike) client.captureException(asError(err as SerializedError), hint);
    else client.captureMessage(message, severity, hint);
  };

  return {
    write(line) {
      if (!REPORTED_LINE.test(line)) return;
      try {
        report(line);
      } catch {
        // A report that cannot be made must never stop the log line or the server.
      }
    },
    flush: (timeoutMs) => Promise.resolve(client.flush(timeoutMs)),
  };
}

/** pino's `err` (`pino-std-serializers`): causes are appended to the message and stack. */
interface SerializedError {
  type?: unknown;
  message?: unknown;
  stack?: unknown;
}

/**
 * The logged error as an `Error` for the SDK, whose stack parser reads its frames. Only
 * the frames of the error itself: a cause's stack follows `caused by:` and stays in the
 * message, as in the log.
 */
function asError({ type, message, stack }: SerializedError): Error {
  const error = new Error(String(message ?? ""));
  error.name = typeof type === "string" && type ? type : "Error";
  error.stack = typeof stack === "string" ? (stack.split("\ncaused by: ")[0] ?? "") : "";
  return error;
}
