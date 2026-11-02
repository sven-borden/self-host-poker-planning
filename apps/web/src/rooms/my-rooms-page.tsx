import { MAX_ROOM_NAME_LENGTH } from "@pp/domain";
import { Link } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { EmptyTable } from "../components/shell/empty-table.tsx";
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
import { useFormat, useT } from "../i18n/hooks.ts";
import { ensureIdentity } from "../identity/identity.ts";
import { signInProviders } from "../identity/sign-in.ts";
import { SignInRow } from "../identity/sign-in-row.tsx";
import { RiseIn } from "../motion/motion.tsx";
import { codeOf, failureMessage } from "../room/failure.ts";
import { isSignedIn, useIdentityStore } from "../stores/identity-store.ts";
import {
  deleteMyRoom,
  fetchMyRooms,
  leaveMyRoom,
  type MyRoom,
  type MyRoomsPage as Page,
  renameMyRoom,
} from "./my-rooms-api.ts";

/** The name input takes this many code units, as on the create card. */
const NAME_INPUT_MAX_UNITS = MAX_ROOM_NAME_LENGTH * 4;

type Load =
  | { status: "loading" }
  | { status: "failed"; code: string }
  | { status: "ready"; page: Page };

/** What is open over the list. */
type Asked = { kind: "rename" | "delete" | "leave"; room: MyRoom } | null;

/**
 * "My rooms" (#49, ADR-027): a list a person scans to get back to the right room. An account's
 * alone: someone signed out gets a way to sign in, and an install with no provider has no such
 * page. The server holds all of that too; this only says it kindly.
 */
export function MyRoomsPage() {
  const t = useT();
  const status = useIdentityStore((state) => state.status);
  const signedIn = useIdentityStore(isSignedIn);
  const [providers] = useState(signInProviders);
  // Someone signed in stays on the list while `MyRoomsList` asks the server who this is.
  const known = status === "ready" || status === "error" || (status === "loading" && signedIn);
  if (known && !signedIn && providers.length === 0) return <NoSuchPage />;
  return (
    <>
      <PageTitle />
      <RiseIn data-my-rooms className="flex max-w-3xl flex-col gap-8">
        {!known ? (
          <p role="status" className="text-ink-2">
            {t("myRooms.loading")}
          </p>
        ) : signedIn ? (
          <MyRoomsList />
        ) : (
          <SignedOut />
        )}
      </RiseIn>
    </>
  );
}

/** A component of its own: the page without a provider is the not-found page, with its title. */
function PageTitle() {
  const t = useT();
  usePageTitle(t("myRooms.title"));
  return null;
}

/**
 * What the root's `NotFoundPage` shows, in this chunk's own lines: importing that component here
 * makes the bundler split the entry chunk around it, which costs every page 1.8 kB.
 */
function NoSuchPage() {
  const t = useT();
  usePageTitle(t("notFound.title"));
  return (
    <section className="max-w-2xl">
      <EmptyTable />
      <h1 className="mt-6 text-3xl font-[760] [font-stretch:110%] sm:text-4xl">
        {t("notFound.title")}
      </h1>
      <p className="mt-4 text-ink-2">{t("notFound.body")}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}

function Heading({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div>
      <h1
        tabIndex={-1}
        data-my-rooms-title
        className="text-3xl font-[760] outline-none [font-stretch:110%] sm:text-4xl"
      >
        {t("myRooms.title")}
      </h1>
      <div className="mt-4 flex max-w-prose flex-col gap-2 text-ink-2">{children}</div>
    </div>
  );
}

function SignedOut() {
  const t = useT();
  return (
    <>
      <Heading>
        <p>{t("myRooms.signedOut")}</p>
      </Heading>
      <SignInRow className="max-w-xl" />
      <Link to="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
        {t("room.backHome")}
      </Link>
    </>
  );
}

function MyRoomsList() {
  const t = useT();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState<Asked>(null);
  /** What the last action did, said once in the page. */
  const [notice, setNotice] = useState<string | null>(null);
  const [more, setMore] = useState<"idle" | "busy" | { failed: string }>("idle");
  /** The button that opened the dialog, for the focus to go back to. */
  const opener = useRef<HTMLElement | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again.
  useEffect(() => {
    let current = true;
    const failed = (code: string) => {
      if (current) setLoad({ status: "failed", code });
    };
    setLoad({ status: "loading" });
    setMore("idle");
    fetchMyRooms().then(
      (page) => current && setLoad({ status: "ready", page }),
      (error: unknown) => {
        const code = codeOf(error);
        if (code !== "not_allowed" && code !== "unauthenticated") return failed(code);
        // The session ended, here or in another tab, and the store still says signed in. Asked
        // again, it holds a guest, and the page above offers the sign-in. Should the server call
        // this an account all the same, the list says what it heard.
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

  const page = load.status === "ready" ? load.page : null;
  const change = (update: (rooms: readonly MyRoom[]) => readonly MyRoom[]) =>
    setLoad((now) =>
      now.status === "ready"
        ? { ...now, page: { ...now.page, rooms: update(now.page.rooms) } }
        : now,
    );

  async function showMore() {
    if (!page || more === "busy" || page.next === undefined) return;
    setMore("busy");
    try {
      const further = await fetchMyRooms(page.next);
      const { next: _, ...rest } = page;
      setLoad({
        status: "ready",
        page: {
          ...rest,
          rooms: [...page.rooms, ...further.rooms],
          ...(further.next !== undefined && { next: further.next }),
        },
      });
      setMore("idle");
    } catch (error) {
      setMore({ failed: codeOf(error) });
    }
  }

  /**
   * A dialog went: the focus goes back to the button that opened it, and to the page's title when
   * that button went too, with its row. `onCloseAutoFocus` is the one moment for it: Radix calls
   * it once the dialog has let go, and without a `DialogTrigger` it would leave the focus on
   * `<body>`.
   */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>("[data-my-rooms-title]");
    target?.focus();
  };

  /** An action finished: its dialog goes, and the page says so. */
  function done(message: string) {
    setAsked(null);
    setNotice(message);
  }

  /** The list was out of date: what the server said, and the list as it is now. */
  function outdated(code: string) {
    opener.current = null;
    setAsked(null);
    setNotice(code === "room_not_found" ? t("myRooms.gone") : failureMessage(t, code));
    reload();
  }

  const name = (room: MyRoom) => room.name ?? t("room.title", { code: room.code });

  return (
    <>
      <Heading>
        {load.status === "loading" && <p role="status">{t("myRooms.loading")}</p>}
        {load.status === "failed" && <p role="alert">{failureMessage(t, load.code)}</p>}
        {page && (
          <>
            <p>{t("myRooms.intro")}</p>
            <p>{t("myRooms.retention", { count: page.retentionDays })}</p>
          </>
        )}
      </Heading>
      {/*
        There from the start, as a line added already holding its words is not announced. Empty,
        it gives back the gap the layout gives it.
      */}
      <p
        role="status"
        data-my-rooms-notice
        className="m-0 max-w-prose text-sm text-ink-2 empty:-mt-8"
      >
        {notice}
      </p>
      {load.status === "failed" && (
        <div className="flex flex-wrap gap-3">
          <Button onClick={reload}>{t("room.retry")}</Button>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            {t("room.backHome")}
          </Link>
        </div>
      )}
      {page?.moving && (
        <div className="flex flex-wrap items-center gap-3" data-my-rooms-moving>
          <p role="status" className="m-0 max-w-prose">
            {t("myRooms.moving")}
          </p>
          <Button variant="outline" onClick={reload}>
            {t("room.retry")}
          </Button>
        </div>
      )}
      {page &&
        (page.rooms.length === 0 ? (
          <div data-my-rooms-empty className="flex flex-col items-start gap-4">
            <EmptyTable />
            <p className="m-0 font-semibold">{t("myRooms.emptyTitle")}</p>
            <p className="m-0 text-ink-2">{t("myRooms.emptyBody")}</p>
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              {t("roomGone.createRoom")}
            </Link>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col border-t border-line p-0">
            {page.rooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                name={name(room)}
                ask={(kind, from) => {
                  opener.current = from;
                  setNotice(null);
                  setAsked({ kind, room });
                }}
              />
            ))}
          </ul>
        ))}
      {page?.next !== undefined && (
        <div className="flex flex-col items-start gap-2">
          <Button variant="outline" aria-disabled={more === "busy" || undefined} onClick={showMore}>
            {t("myRooms.showMore")}
          </Button>
          {typeof more === "object" && (
            <p role="alert" className="m-0 text-sm">
              {failureMessage(t, more.failed)}
            </p>
          )}
        </div>
      )}
      {asked?.kind === "rename" && (
        <RenameDialog
          room={asked.room}
          close={() => setAsked(null)}
          returnFocus={returnFocus}
          renamed={(stored) => {
            change((rooms) =>
              rooms.map((room) => (room.id === asked.room.id ? { ...room, name: stored } : room)),
            );
            done(t("myRooms.renamed"));
          }}
          outdated={outdated}
        />
      )}
      {asked?.kind === "delete" && (
        <ConfirmDialog
          title={t("myRooms.deleteTitle", { name: name(asked.room) })}
          confirm={t("myRooms.deleteConfirm")}
          destructive
          run={() => deleteMyRoom(asked.room.id)}
          close={() => setAsked(null)}
          returnFocus={returnFocus}
          finished={() => {
            change((rooms) => rooms.filter((room) => room.id !== asked.room.id));
            done(t("myRooms.deleted"));
          }}
          outdated={outdated}
        >
          <p className="m-0">{t("myRooms.deleteBody")}</p>
          <p className="m-0">{t("myRooms.deleteLive")}</p>
        </ConfirmDialog>
      )}
      {asked?.kind === "leave" && (
        <ConfirmDialog
          title={t("myRooms.leaveTitle", { name: name(asked.room) })}
          confirm={t("myRooms.leave")}
          run={() => leaveMyRoom(asked.room.id)}
          close={() => setAsked(null)}
          returnFocus={returnFocus}
          finished={() => {
            // A room that is still this person's stays on the list, with no seat to leave.
            change((rooms) =>
              asked.room.keeper
                ? rooms.map((room) =>
                    room.id === asked.room.id ? { ...room, seated: false } : room,
                  )
                : rooms.filter((room) => room.id !== asked.room.id),
            );
            done(t("myRooms.left"));
          }}
          outdated={outdated}
        >
          <p className="m-0">{t(asked.room.keeper ? "myRooms.leaveKept" : "myRooms.leaveBody")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function RoomRow({
  room,
  name,
  ask,
}: {
  room: MyRoom;
  name: string;
  ask: (kind: "rename" | "delete" | "leave", from: HTMLElement) => void;
}) {
  const t = useT();
  const format = useFormat();
  // The role and the right to delete can part: someone took over as PO (ADR-027).
  const mayDelete = room.owned && room.keeper;
  const whose = mayDelete ? "owned" : room.owned ? "claimed" : room.keeper ? "kept" : "joined";
  return (
    <li
      data-my-room={whose}
      className="flex flex-col gap-3 border-b border-line py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <div className="min-w-0">
        <Link
          to="/r/$code"
          params={{ code: room.code }}
          className="rounded-sm font-semibold wrap-anywhere underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <bdi>{name}</bdi>
        </Link>
        <p className="m-0 mt-1 flex flex-wrap gap-x-3 text-sm text-ink-2">
          <span>{t(`myRooms.${whose}`)}</span>
          <time dateTime={room.lastActiveAt} title={format.date(new Date(room.lastActiveAt))}>
            {t("myRooms.lastActive", { when: format.relativeTime(new Date(room.lastActiveAt)) })}
          </time>
          <span>{t("myRooms.rounds", { count: room.rounds })}</span>
        </p>
        {whose === "claimed" && (
          <p className="m-0 mt-1 max-w-prose text-sm text-ink-2">{t("myRooms.claimedWhy")}</p>
        )}
        {whose === "kept" && (
          <p className="m-0 mt-1 max-w-prose text-sm text-ink-2">{t("myRooms.keptWhy")}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {room.owned && (
          <Button
            variant="outline"
            aria-label={t("myRooms.renameNamed", { name })}
            onClick={(event) => ask("rename", event.currentTarget)}
          >
            {t("myRooms.rename")}
          </Button>
        )}
        {mayDelete && (
          <Button
            variant="outline"
            aria-label={t("myRooms.deleteNamed", { name })}
            onClick={(event) => ask("delete", event.currentTarget)}
          >
            {t("myRooms.delete")}
          </Button>
        )}
        {!mayDelete && room.seated && (
          <Button
            variant="outline"
            aria-label={t("myRooms.leaveNamed", { name })}
            onClick={(event) => ask("leave", event.currentTarget)}
          >
            {t("myRooms.leave")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** What went wrong, under a dialog's fields. */
function Failure({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="m-0 flex items-start gap-2 text-sm">
      <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
      {message}
    </p>
  );
}

/** The codes that say the list is out of date, not that this action can be tried again. */
const OUTDATED: ReadonlySet<string> = new Set([
  "room_not_found",
  "not_owner",
  "not_keeper",
  "not_participant",
]);

function RenameDialog({
  room,
  close,
  returnFocus,
  renamed,
  outdated,
}: {
  room: MyRoom;
  close: () => void;
  returnFocus: (event: Event) => void;
  renamed: (name: string) => void;
  outdated: (code: string) => void;
}) {
  const t = useT();
  const inputId = useId();
  const [value, setValue] = useState(room.name ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      renamed(await renameMyRoom(room.id, value));
    } catch (error) {
      setBusy(false);
      const code = codeOf(error);
      if (OUTDATED.has(code)) outdated(code);
      else {
        setFailure(failureMessage(t, code));
        input.current?.focus();
      }
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        data-my-rooms-dialog
        onCloseAutoFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>{t("myRooms.renameTitle")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="font-medium">
              {t("myRooms.nameLabel")}
            </label>
            <Input
              id={inputId}
              ref={input}
              value={value}
              maxLength={NAME_INPUT_MAX_UNITS}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Failure message={failure} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("myRooms.cancel")}
            </Button>
            <Button type="submit" aria-disabled={busy || undefined}>
              {t("myRooms.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  confirm,
  destructive = false,
  run,
  close,
  returnFocus,
  finished,
  outdated,
  children,
}: {
  title: string;
  confirm: string;
  destructive?: boolean;
  run: () => Promise<void>;
  close: () => void;
  returnFocus: (event: Event) => void;
  finished: () => void;
  outdated: (code: string) => void;
  children: ReactNode;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function press() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await run();
      finished();
    } catch (error) {
      setBusy(false);
      const code = codeOf(error);
      if (OUTDATED.has(code)) outdated(code);
      else setFailure(failureMessage(t, code));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent data-my-rooms-dialog onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">
            <bdi>{title}</bdi>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">{children}</div>
          </DialogDescription>
        </DialogHeader>
        <Failure message={failure} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("myRooms.cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            aria-disabled={busy || undefined}
            onClick={press}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
