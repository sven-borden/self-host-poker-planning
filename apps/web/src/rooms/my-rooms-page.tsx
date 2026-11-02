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
import { NotFoundPage } from "../components/shell/not-found-page.tsx";
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
  /** The server takes this person for no account: the session changed in another tab. */
  | { status: "signedOut" }
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
  const known = status === "ready" || status === "error";
  if (known && !signedIn && providers.length === 0) return <NotFoundPage />;
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
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again.
  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    setMore("idle");
    fetchMyRooms().then(
      (page) => current && setLoad({ status: "ready", page }),
      (error: unknown) => {
        if (!current) return;
        const code = codeOf(error);
        const signedOut = code === "not_allowed" || code === "unauthenticated";
        setLoad(signedOut ? { status: "signedOut" } : { status: "failed", code });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  if (load.status === "signedOut") return <SignedOut />;
  if (load.status === "loading") {
    return (
      <Heading>
        <p role="status">{t("myRooms.loading")}</p>
      </Heading>
    );
  }
  if (load.status === "failed") {
    return (
      <>
        <Heading>
          <p role="alert">{failureMessage(t, load.code)}</p>
        </Heading>
        <div className="flex flex-wrap gap-3">
          <Button onClick={reload}>{t("room.retry")}</Button>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            {t("room.backHome")}
          </Link>
        </div>
      </>
    );
  }

  const { page } = load;
  const change = (update: (rooms: readonly MyRoom[]) => readonly MyRoom[]) =>
    setLoad({ status: "ready", page: { ...page, rooms: update(page.rooms) } });

  async function showMore() {
    if (more === "busy" || page.next === undefined) return;
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
   * An action finished: its dialog goes, and the page says so. The button that opened the dialog
   * may have gone with the row, so the focus goes to the page's title, once the dialog let it go.
   */
  function done(message: string) {
    setAsked(null);
    setNotice(message);
    setTimeout(() => {
      document.querySelector<HTMLElement>("[data-my-rooms-title]")?.focus();
    }, 0);
  }

  /** The list was out of date: what the server said, and the list as it is now. */
  function outdated(code: string) {
    setAsked(null);
    setNotice(code === "room_not_found" ? t("myRooms.gone") : failureMessage(t, code));
    reload();
  }

  const name = (room: MyRoom) => room.name ?? t("room.title", { code: room.code });

  return (
    <>
      <Heading>
        <p>{t("myRooms.intro")}</p>
        <p>{t("myRooms.retention", { count: page.retentionDays })}</p>
      </Heading>
      {page.moving && (
        <div className="flex flex-wrap items-center gap-3" data-my-rooms-moving>
          <p role="status" className="m-0 max-w-prose">
            {t("myRooms.moving")}
          </p>
          <Button variant="outline" onClick={reload}>
            {t("room.retry")}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="m-0 max-w-prose text-sm text-ink-2">
          {notice}
        </p>
      )}
      {page.rooms.length === 0 ? (
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
              ask={(kind) => {
                setNotice(null);
                setAsked({ kind, room });
              }}
            />
          ))}
        </ul>
      )}
      {page.next !== undefined && (
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
          finished={() => {
            change((rooms) => rooms.filter((room) => room.id !== asked.room.id));
            done(t("myRooms.left"));
          }}
          outdated={outdated}
        >
          <p className="m-0">{t("myRooms.leaveBody")}</p>
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
  ask: (kind: "rename" | "delete" | "leave") => void;
}) {
  const t = useT();
  const format = useFormat();
  return (
    <li
      data-my-room={room.owned ? "owned" : "joined"}
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
          <span>{room.owned ? t("myRooms.owned") : t("myRooms.joined")}</span>
          <time dateTime={room.lastActiveAt} title={format.date(new Date(room.lastActiveAt))}>
            {t("myRooms.lastActive", { when: format.relativeTime(new Date(room.lastActiveAt)) })}
          </time>
          <span>{t("myRooms.rounds", { count: room.rounds })}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {room.owned ? (
          <>
            <Button
              variant="outline"
              aria-label={t("myRooms.renameNamed", { name })}
              onClick={() => ask("rename")}
            >
              {t("myRooms.rename")}
            </Button>
            <Button
              variant="outline"
              aria-label={t("myRooms.deleteNamed", { name })}
              onClick={() => ask("delete")}
            >
              {t("myRooms.delete")}
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            aria-label={t("myRooms.leaveNamed", { name })}
            onClick={() => ask("leave")}
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
const OUTDATED: ReadonlySet<string> = new Set(["room_not_found", "not_owner", "not_participant"]);

function RenameDialog({
  room,
  close,
  renamed,
  outdated,
}: {
  room: MyRoom;
  close: () => void;
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
      <DialogContent aria-describedby={undefined} data-my-rooms-dialog>
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
  finished,
  outdated,
  children,
}: {
  title: string;
  confirm: string;
  destructive?: boolean;
  run: () => Promise<void>;
  close: () => void;
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
      <DialogContent data-my-rooms-dialog>
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
