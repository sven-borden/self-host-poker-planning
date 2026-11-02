import { ACCOUNT_DELETE_WORDS, isAccountDeleteWord } from "@pp/protocol";
import { Link } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { NoSuchPage } from "../components/shell/no-such-page.tsx";
import { usePageTitle } from "../components/shell/use-page-title.ts";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { useFormat, useLanguage, useT } from "../i18n/hooks.ts";
import { ensureIdentity, startSignIn } from "../identity/identity.ts";
import { signInProviders } from "../identity/sign-in.ts";
import { busyClass, SignInRow } from "../identity/sign-in-row.tsx";
import { RiseIn } from "../motion/motion.tsx";
import { codeOf, failureMessage } from "../room/failure.ts";
import { isSignedIn, useIdentityStore } from "../stores/identity-store.ts";
import {
  type AccountOverview,
  deleteAccount,
  downloadAccount,
  fetchAccount,
  type RoomChoice,
  type SharedRoom,
} from "./account-api.ts";
import { type AccountT, useAccountT } from "./account-copy.ts";

const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft" } as const;

/** What a person picked for a room: a seat's id, or this. Nothing picked is the first seat. */
const DELETE_ROOM = "delete";

/** How the select says who the default is, and why. */
const DEFAULT_TAKER = {
  runsTheRoom: "takerRunning",
  here: "takerHere",
  away: "takerAway",
  nobody: "takerNone",
} as const satisfies Record<SharedRoom["why"], Parameters<AccountT>[0]>;

type Load =
  | { status: "loading" }
  | { status: "failed"; code: string }
  | { status: "ready"; overview: AccountOverview };

/**
 * How a deletion ended: all gone, on its way, a request nobody heard the end of, or a request the
 * server refused because the session had already ended, so it deleted nothing.
 */
type Ending = "done" | "going" | "lost" | "signedOut";

/**
 * The account page (#51, ADR-029): a person's way to their data, and out. An account's alone:
 * someone signed out gets a way to sign in, and an install with no provider has no such page. The
 * server holds all of that too, the deletion's guards included: this only says it kindly.
 */
export function AccountPage() {
  const t = useAccountT();
  const status = useIdentityStore((state) => state.status);
  const signedIn = useIdentityStore(isSignedIn);
  const [providers] = useState(signInProviders);
  const [ending, setEnding] = useState<Ending | null>(null);
  const known = status === "ready" || status === "error" || (status === "loading" && signedIn);
  if (ending !== null) return <Ended ending={ending} />;
  if (known && !signedIn && providers.length === 0) return <NoSuchPage />;
  return (
    <>
      <PageTitle />
      <RiseIn data-account className="flex max-w-3xl flex-col gap-10">
        {!known ? (
          <p role="status" className="text-ink-2">
            {t("loading")}
          </p>
        ) : signedIn ? (
          <Account ended={setEnding} />
        ) : (
          <SignedOut />
        )}
      </RiseIn>
    </>
  );
}

/** A component of its own: the page without a provider is the not-found page, with its title. */
function PageTitle() {
  const t = useAccountT();
  usePageTitle(t("title"));
  return null;
}

function Heading({ children }: { children?: ReactNode }) {
  const t = useAccountT();
  return (
    <div>
      <h1
        tabIndex={-1}
        data-account-title
        className="text-3xl font-[760] outline-none [font-stretch:110%] sm:text-4xl"
      >
        {t("title")}
      </h1>
      {children}
    </div>
  );
}

function SignedOut() {
  const t = useAccountT();
  const shell = useT();
  return (
    <>
      <Heading>
        <p className="mt-4 max-w-prose text-ink-2">{t("signedOut")}</p>
      </Heading>
      <SignInRow className="max-w-xl" />
      <Link to="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
        {shell("room.backHome")}
      </Link>
    </>
  );
}

function Account({ ended }: { ended: (ending: Ending) => void }) {
  const t = useAccountT();
  const shell = useT();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** By room id, what the person picked. */
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [asking, setAsking] = useState(false);
  /** The deletion was refused for an old session: said above the sign-in. */
  const [tooOld, setTooOld] = useState(false);
  const email = useIdentityStore((state) => state.email);
  const name = useIdentityStore((state) => state.name);
  const provider = useIdentityStore((state) => state.provider);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again.
  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    fetchAccount().then(
      (overview) => current && setLoad({ status: "ready", overview }),
      (error: unknown) => {
        const code = codeOf(error);
        const failed = (found: string) => current && setLoad({ status: "failed", code: found });
        if (code !== "not_allowed" && code !== "unauthenticated") return failed(code);
        // The session ended, here or in another tab: asked again, the store holds a guest, and
        // the page above offers the sign-in.
        ensureIdentity({ force: true }).then(
          () => failed(code),
          (reason: unknown) => failed(codeOf(reason)),
        );
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const overview = load.status === "ready" ? load.overview : null;
  const choices: RoomChoice[] = Object.entries(picked).map(([id, pick]) =>
    pick === DELETE_ROOM ? { id, delete: true } : { id, to: pick },
  );

  return (
    <>
      <Heading>
        <div className="mt-4 flex max-w-prose flex-col gap-2 text-ink-2">
          {provider !== null && (
            <p className="m-0">
              {shell("signIn.signedInWith", { provider: PROVIDER_NAMES[provider] })}
            </p>
          )}
          {(email ?? name) !== null && (
            <p className="m-0 font-medium wrap-anywhere text-ink">
              <bdi>{email ?? name}</bdi>
            </p>
          )}
          {load.status === "loading" && <p role="status">{t("loading")}</p>}
          {load.status === "failed" && <p role="alert">{failureMessage(shell, load.code)}</p>}
        </div>
      </Heading>
      {load.status === "failed" && (
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setAttempt((n) => n + 1)}>{shell("room.retry")}</Button>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            {shell("room.backHome")}
          </Link>
        </div>
      )}
      {overview?.moving && (
        <div className="flex flex-wrap items-center gap-3" data-account-moving>
          <p role="status" className="m-0 max-w-prose">
            {t("moving")}
          </p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {shell("room.retry")}
          </Button>
        </div>
      )}
      {overview && (
        <>
          <ExportSection />
          <DeleteSection
            overview={overview}
            picked={picked}
            pick={(id, pick) =>
              setPicked(({ [id]: _, ...rest }) => (pick === "" ? rest : { ...rest, [id]: pick }))
            }
            tooOld={tooOld}
            ask={() => setAsking(true)}
          />
        </>
      )}
      {asking && (
        <ConfirmDialog
          choices={choices}
          close={() => setAsking(false)}
          ended={ended}
          tooOld={() => {
            setAsking(false);
            setTooOld(true);
            setAttempt((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <h2 className="m-0 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ExportSection() {
  const t = useAccountT();
  const shell = useT();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      setNotice(t((await downloadAccount()) ? "exported" : "exportIncomplete"));
    } catch (error) {
      setFailure(failureMessage(shell, codeOf(error)));
    }
    setBusy(false);
  }

  return (
    <Section title={t("exportTitle")}>
      <p className="m-0 max-w-prose text-ink-2">{t("exportBody")}</p>
      <p className="m-0 max-w-prose text-ink-2">{t("exportCodes")}</p>
      <Button
        variant="outline"
        className={`self-start ${busyClass}`}
        data-account-export
        aria-disabled={busy || undefined}
        onClick={download}
      >
        {busy ? t("exportBusy") : t("exportAction")}
      </Button>
      {/* There from the start: a line added already holding its words is not announced. */}
      <p
        role="status"
        data-account-exported
        className="m-0 max-w-prose text-sm text-ink-2 empty:hidden"
      >
        {notice}
      </p>
      <Failure message={failure} />
    </Section>
  );
}

function DeleteSection({
  overview,
  picked,
  pick,
  tooOld,
  ask,
}: {
  overview: AccountOverview;
  picked: Readonly<Record<string, string>>;
  pick: (id: string, pick: string) => void;
  tooOld: boolean;
  ask: () => void;
}) {
  const t = useAccountT();
  const { alone, seats, held, shared, retentionDays, recent } = overview;
  return (
    <Section title={t("deleteTitle")}>
      <p className="m-0 max-w-prose">{t("deleteIntro")}</p>
      <div className="grid gap-6 sm:grid-cols-2">
        <Listing title={t("goesTitle")}>
          <li>{t("goesAccount")}</li>
          {alone > 0 && <li>{t("goesAlone", { count: alone })}</li>}
          {seats > 0 && <li>{t("goesSeats", { count: seats })}</li>}
          {held > 0 && <li>{t("goesHeld", { count: held, days: retentionDays })}</li>}
          <li>{t("goesNames")}</li>
        </Listing>
        <Listing title={t("staysTitle")}>
          <li>{t("staysCards")}</li>
          <li>{t("staysWords")}</li>
          <li>{t("staysCopies")}</li>
          <li>{t("staysBackups")}</li>
          <li>{t("staysLogs")}</li>
        </Listing>
      </div>
      {shared.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="m-0 font-semibold">{t("sharedTitle")}</h3>
          <p className="m-0 max-w-prose text-sm text-ink-2">{t("sharedIntro")}</p>
          <p className="m-0 max-w-prose text-sm text-ink-2">
            {t("sharedGuest", { count: retentionDays })}
          </p>
          <ul className="m-0 flex list-none flex-col border-t border-line p-0">
            {shared.map((room) => (
              <SharedRow
                key={room.id}
                room={room}
                value={picked[room.id] ?? ""}
                pick={(value) => pick(room.id, value)}
              />
            ))}
          </ul>
        </div>
      )}
      {recent ? (
        <Button variant="destructive" className="self-start" data-account-delete onClick={ask}>
          {t("deleteAction")}
        </Button>
      ) : (
        <SignInAgain tooOld={tooOld} />
      )}
    </Section>
  );
}

function Listing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="m-0 mb-2 font-semibold">{title}</h3>
      <ul className="m-0 flex list-disc flex-col gap-1 ps-5 text-sm text-ink-2">{children}</ul>
    </div>
  );
}

function SharedRow({
  room,
  value,
  pick,
}: {
  room: SharedRoom;
  value: string;
  pick: (value: string) => void;
}) {
  const t = useAccountT();
  const shell = useT();
  const format = useFormat();
  const id = useId();
  const name = room.name ?? t("unnamed");
  const [first, ...rest] = room.seats;
  return (
    <li
      data-account-room
      className="flex flex-col gap-2 border-b border-line py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
    >
      <div className="min-w-0">
        <p className="m-0 font-semibold wrap-anywhere">
          <bdi>{name}</bdi>
        </p>
        <p className="m-0 text-sm text-ink-2">
          {shell("myRooms.lastActive", { when: format.relativeTime(new Date(room.lastActiveAt)) })}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1 sm:w-64 sm:shrink-0">
        <label htmlFor={id} className="text-sm font-medium wrap-anywhere">
          {t("takerLabel", { name })}
        </label>
        <select
          id={id}
          value={value}
          onChange={(event) => pick(event.target.value)}
          className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden md:text-sm"
        >
          <option value="">{t(DEFAULT_TAKER[room.why], { name: first?.name ?? "" })}</option>
          {rest.map((seat) => (
            <option key={seat.id} value={seat.id}>
              {seat.name}
            </option>
          ))}
          <option value={DELETE_ROOM}>{t("takerDelete")}</option>
        </select>
        {value === DELETE_ROOM && <p className="m-0 text-sm">{t("deleteChosen")}</p>}
      </div>
    </li>
  );
}

/** A deletion takes a recent sign-in: this page's way there, and back. */
function SignInAgain({ tooOld }: { tooOld: boolean }) {
  const t = useAccountT();
  const shell = useT();
  const provider = useIdentityStore((state) => state.provider);
  const [providers] = useState(signInProviders);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ways = provider !== null && providers.includes(provider) ? [provider] : providers;

  async function again(id: (typeof ways)[number]) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      window.location.assign(await startSignIn(id, "/account"));
    } catch (error) {
      setFailure(failureMessage(shell, codeOf(error)));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-account-again>
      {tooOld && (
        <p role="status" className="m-0 max-w-prose">
          {t("againNeeded")}
        </p>
      )}
      <p className="m-0 max-w-prose text-ink-2">{t("againBody")}</p>
      <div className="flex flex-wrap gap-2">
        {ways.map((id) => (
          <Button
            key={id}
            variant="outline"
            className={busyClass}
            aria-disabled={busy || undefined}
            onClick={() => again(id)}
          >
            {ways.length > 1 ? t("againWith", { provider: PROVIDER_NAMES[id] }) : t("againAction")}
          </Button>
        ))}
      </div>
      <Failure message={failure} />
    </div>
  );
}

/** What went wrong, under a form. */
function Failure({ id, message }: { id?: string; message: string | null }) {
  if (message === null) return null;
  return (
    <p id={id} role="alert" className="m-0 flex items-start gap-2 text-sm">
      <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
      {message}
    </p>
  );
}

/**
 * The dialog went: the focus goes back to the button that opened it, and to the page's title when
 * the sign-in has taken that button's place. Without a `DialogTrigger`, Radix would leave it on
 * `<body>`.
 */
function returnFocus(event: Event) {
  event.preventDefault();
  const target =
    document.querySelector<HTMLElement>("[data-account-delete]") ??
    document.querySelector<HTMLElement>("[data-account-title]");
  target?.focus();
}

/** A refusal that says what happened: the person is who they were, and nothing changed. */
const REFUSED: ReadonlySet<string> = new Set(["bad_confirmation", "rate_limited", "bad_payload"]);

/** The server would not listen to this session: this request deleted nothing. */
const NOT_HEARD: ReadonlySet<string> = new Set(["unauthenticated", "not_allowed"]);

function ConfirmDialog({
  choices,
  close,
  ended,
  tooOld,
}: {
  choices: readonly RoomChoice[];
  close: () => void;
  ended: (ending: Ending) => void;
  tooOld: () => void;
}) {
  const t = useAccountT();
  const shell = useT();
  const [language] = useLanguage();
  const inputId = useId();
  const failureId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [wrongWord, setWrongWord] = useState(false);
  const word = ACCOUNT_DELETE_WORDS[language];
  const ready = isAccountDeleteWord(typed);

  function refuse(code: string) {
    setWrongWord(code === "bad_confirmation");
    setFailure(failureMessage(shell, code));
  }

  /** Whether this browser is still the account, now. Rejects with no answer. */
  async function stillSignedIn() {
    await ensureIdentity({ force: true });
    return isSignedIn(useIdentityStore.getState());
  }

  /**
   * Every way a deletion ended: only what the server said may be said to the person. It stays busy
   * until it knows, so that nothing can close the dialog on an answer still to come.
   */
  async function run() {
    let finished: boolean;
    try {
      finished = await deleteAccount(typed, choices);
    } catch (error) {
      const code = codeOf(error);
      if (code === "sign_in_again") return tooOld();
      if (REFUSED.has(code)) {
        setBusy(false);
        return refuse(code);
      }
      if (NOT_HEARD.has(code)) {
        const still = await stillSignedIn().catch(() => false);
        setBusy(false);
        return still ? setFailure(t("nothingDeleted")) : ended("signedOut");
      }
      // A failure that does not say how far it got: who this browser is now does.
      const still = await stillSignedIn().catch(() => null);
      setBusy(false);
      if (still === null) return setFailure(t("noAnswer"));
      return still ? setFailure(t("nothingDeleted")) : ended("lost");
    }
    ended(finished ? "done" : "going");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!ready) return refuse("bad_confirmation");
    setBusy(true);
    setFailure(null);
    setWrongWord(false);
    void run();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent data-account-dialog onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>{t("confirmBody")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="font-medium">
              {t("confirmLabel", { word })}
            </label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              aria-invalid={wrongWord || undefined}
              aria-describedby={failure === null ? undefined : failureId}
              onChange={(event) => {
                setTyped(event.target.value);
                setFailure(null);
                setWrongWord(false);
              }}
            />
          </div>
          <Failure id={failureId} message={failure} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className={busyClass}
              onClick={() => !busy && close()}
              aria-disabled={busy || undefined}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className={busyClass}
              aria-disabled={busy || undefined}
            >
              {busy ? t("deleting") : t("confirmAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ENDINGS = {
  done: ["doneTitle", "doneBody"],
  going: ["goingTitle", "goingBody"],
  lost: ["lostTitle", "lostBody"],
  signedOut: ["lostTitle", "outBody"],
} as const satisfies Record<Ending, readonly Parameters<AccountT>[0][]>;

/**
 * The end: what became of the account, in the words the server's answer allows, on a page that
 * asks nothing more, except a way back in for someone whose request deleted nothing. The browser
 * turns into a fresh guest behind it.
 */
function Ended({ ending }: { ending: Ending }) {
  const t = useAccountT();
  const [title, body] = ENDINGS[ending];
  usePageTitle(t(title));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    ensureIdentity({ force: true }).catch(() => {
      // The next page load tries again.
    });
  }, []);
  return (
    <RiseIn data-account-ended={ending} className="flex max-w-3xl flex-col gap-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-3xl font-[760] outline-none [font-stretch:110%] sm:text-4xl"
      >
        {t(title)}
      </h1>
      <p className="m-0 max-w-prose">{t(body)}</p>
      {ending === "done" && <p className="m-0 max-w-prose text-ink-2">{t("doneRemains")}</p>}
      {ending === "signedOut" && <SignInRow className="max-w-xl" />}
      <a href="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
        {t("home")}
      </a>
    </RiseIn>
  );
}
