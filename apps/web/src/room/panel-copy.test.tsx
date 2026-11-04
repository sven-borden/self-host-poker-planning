import { createRoom, type Participant } from "@pp/domain";
import { toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COPY_LOADERS } from "../i18n/copy-parts.ts";
import { changeLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { RoomHistoryButton } from "./history-button.tsx";
import { RoomQueueButton } from "./queue-button.tsx";
import { RoomSettingsButton } from "./settings-button.tsx";

// The panels' buttons wait for their words (U6): a panel shows once its part is in, in the page's
// language, never a key or English first. A file of its own, so that no other test has loaded a
// panel's German part before its button asks for it (copy-parts.test.tsx loads several).

// The panels ask the server for their lists; here the answer never comes, which they show as
// loading, in their own words.
vi.mock("../realtime/room-connection.ts", () => ({
  sendCommand: vi.fn(),
  commandSender: vi.fn(),
  requestHistory: () => new Promise(() => {}),
  requestQueue: () => new Promise(() => {}),
}));

/** A promise the test settles by hand, to hold a part's load. */
function held() {
  let settle: (copy: object) => void = () => {};
  const promise = new Promise<object>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Lets pending promises and the renders they cause run. */
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const PANELS = [
  {
    part: "settings",
    button: () => <RoomSettingsButton />,
    open: "[data-settings-open]",
    german: () => import("../i18n/parts/settings-de.ts"),
    keys: /\b(settings|deckField|restriction|password)\.\w/,
    shows: (dialog: HTMLElement) =>
      within(dialog).findByRole("switch", { name: "Anonyme Abstimmung" }),
  },
  {
    part: "history",
    button: () => <RoomHistoryButton roomName={null} />,
    open: "[data-history-open]",
    german: () => import("../i18n/parts/history-de.ts"),
    keys: /\b(history|summary|exports)\.\w/,
    shows: (dialog: HTMLElement) =>
      within(dialog).findByText("Jede abgeschlossene Runde, die neueste zuerst."),
  },
  {
    part: "queue",
    button: () => <RoomQueueButton count={0} />,
    open: "[data-queue-open]",
    german: () => import("../i18n/parts/queue-de.ts"),
    keys: /\b(queue|connector)\.\w/,
    shows: (dialog: HTMLElement) =>
      within(dialog).findByText(/^Was das Team als Nächstes schätzt, der Reihe nach\./),
  },
] satisfies readonly {
  part: "settings" | "history" | "queue";
  button: () => ReactElement;
  open: string;
  german: () => Promise<{ copy: object }>;
  keys: RegExp;
  shows: (dialog: HTMLElement) => Promise<HTMLElement>;
}[];

beforeAll(async () => {
  await Promise.all([
    import("./settings-panel.tsx"),
    import("./history-panel.tsx"),
    import("./queue-panel.tsx"),
  ]);
}, 30_000);

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.getState().reset();
  await act(() => changeLanguage("en"));
});

describe("a panel's button", () => {
  it.each(PANELS)(
    "shows the $part panel once its words are in, never a key or English first",
    async ({ part, button, open, german, keys, shows }) => {
      const room = createRoom({ ownerId: "po" });
      const participants: Record<string, Participant> = {
        po: { name: "Pia", role: "voter", joinedAt: 1, connected: true },
      };
      useRoomStore.getState().open("abcdefghij");
      act(() => {
        useRoomStore
          .getState()
          .receive(
            toSnapshot({ ...room, participants }, "po", { code: "abcdefghij", version: 2, now: 0 }),
          );
        useRoomStore.getState().setStatus("live");
      });
      render(button());
      await act(() => changeLanguage("de"));
      const words = held();
      vi.spyOn(COPY_LOADERS[part], "de").mockImplementation(() => words.promise);

      const opener = document.querySelector<HTMLButtonElement>(open);
      if (!opener) throw new Error(`no ${part} button`);
      fireEvent.click(opener);
      await settled();
      expect(screen.queryByRole("dialog")).toBeNull();

      words.settle(await german().then(({ copy }) => copy));
      const dialog = await screen.findByRole("dialog");
      await shows(dialog);
      expect(dialog.textContent).not.toMatch(keys);
    },
  );
});
