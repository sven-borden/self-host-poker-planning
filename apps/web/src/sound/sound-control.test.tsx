import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, loadLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { audioContext, FakeAudioContext, fakeAudio } from "./fake-audio.ts";
import { RoomSoundButton } from "./sound-button.tsx";
import SoundControl from "./sound-control.tsx";
import { shut } from "./sound-engine.ts";
import { reloadSoundPrefs, SOUND_STORAGE_KEY } from "./sound-prefs.ts";
import { SOUNDS } from "./sound-recipes.ts";

const CODE = "abcdefghij";

function story() {
  let state: RoomState = createRoom({ ownerId: "me" });
  let version = 1;
  return (actor: string, command: Command): Snapshot => {
    // Now, not a made-up time: the timer's ticks read the page's clock.
    const now = Date.now();
    const result = apply(state, command, { actor, now });
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    version += 1;
    return toSnapshot(state, "me", { code: CODE, version, now, causes: result.causes });
  };
}

/** A snapshot arrives, and the task the sounds wait for has run. */
const show = (snapshot: Snapshot) =>
  act(async () => {
    useRoomStore.setState({ snapshot });
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
const saved = (value: object) =>
  window.localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(value));
const button = () => document.querySelector<HTMLButtonElement>("[data-sound]");
const said = () => button()?.getAttribute("aria-label");
const savedPrefs = () => JSON.parse(window.localStorage.getItem(SOUND_STORAGE_KEY) ?? "");
const open = () => {
  const trigger = button();
  if (!trigger) throw new Error("no sound button");
  fireEvent.click(trigger);
};
/** What a browser counts as a gesture. */
const gesture = async () => {
  fireEvent.keyDown(window, { key: "a" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve));
  });
};

describe("the room's sound", () => {
  beforeAll(async () => {
    await loadLanguage("fr");
    await loadLanguage("de");
  });
  beforeEach(() => {
    fakeAudio();
    window.localStorage.clear();
    reloadSoundPrefs();
    useRoomStore.setState({ snapshot: null, status: "live" });
  });
  afterEach(async () => {
    cleanup();
    shut();
    vi.unstubAllGlobals();
    await act(() => changeLanguage("en"));
  });

  function room() {
    const run = story();
    run("me", { type: "join", name: "Me", role: "voter" });
    run("ana", { type: "join", name: "Ana", role: "voter" });
    run("ben", { type: "join", name: "Ben", role: "voter" });
    run("me", { type: "updateSettings", patch: { revealWhenAllVoted: false } });
    useRoomStore.setState({
      snapshot: run("me", { type: "startRound", subject: { kind: "none" } }),
    });
    return run;
  }

  it("is off by default, says so and plays nothing", async () => {
    const run = room();
    render(<SoundControl />);
    expect(said()).toBe("Sound effects: off");
    await gesture();
    await show(run("ana", { type: "castVote", card: "5" }));
    await show(run("me", { type: "reveal" }));
    await gesture();
    expect(FakeAudioContext.made).toEqual([]);
  });

  it("turns on from its switch, heard at once, and is remembered", async () => {
    render(<SoundControl />);
    open();
    fireEvent.click(screen.getByRole("switch", { name: "Play sound effects" }));
    await waitFor(() => expect(audioContext().state).toBe("running"));
    expect(audioContext().sources).toHaveLength(SOUNDS.card.length);
    expect(button()?.dataset.sound).toBe("on");
    expect(savedPrefs()).toMatchObject({ on: true });

    fireEvent.click(screen.getByRole("switch"));
    expect(audioContext().closed).toBe(true);
    expect(said()).toBe("Sound effects: off");
  });

  it("stays silent after a reload until a gesture, and misses what came before it", async () => {
    saved({ on: true, volume: 0.5 });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    expect(said()).toBe("Sound effects: on, from your first click or key press");
    await show(run("ana", { type: "castVote", card: "5" }));
    await show(run("me", { type: "reveal" }));
    expect(FakeAudioContext.made).toEqual([]);

    await gesture();
    expect(audioContext().state).toBe("running");
    expect(said()).toBe("Sound effects: on");
    expect(audioContext().sources).toEqual([]);
  });

  it("plays the room's news once it runs", async () => {
    saved({ on: true });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    await gesture();
    await show(run("ana", { type: "castVote", card: "5" }));
    expect(audioContext().sources).toHaveLength(SOUNDS.card.length);
    await show(run("me", { type: "castVote", card: "5" }));
    expect(audioContext().sources).toHaveLength(2 * SOUNDS.card.length);
  });

  it("lays the timer's last seconds out ahead, and a reveal takes them back, not its own", async () => {
    saved({ on: true });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    await gesture();
    await show(run("me", { type: "startTimer", seconds: 60 }));
    const ticks = audioContext().sources.slice();
    expect(ticks).toHaveLength(5);

    run("ana", { type: "castVote", card: "5" });
    await show(run("me", { type: "castVote", card: "5" }));
    const cards = audioContext().sources.slice(5);
    await show(run("me", { type: "reveal" }));
    for (const tick of ticks) expect(tick.stop).toHaveBeenCalledWith();
    const revealed = audioContext().sources.slice(5 + cards.length);
    expect(revealed.length).toBeGreaterThan(SOUNDS.reveal.length);
    for (const voice of revealed) expect(voice.stop).not.toHaveBeenCalledWith();
  });

  it("lays out a running timer's ticks when the sound starts late", async () => {
    saved({ on: true });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    await show(run("me", { type: "startTimer", seconds: 60 }));
    await gesture();
    expect(audioContext().sources).toHaveLength(5);
  });

  it("takes the flicks back when the next round starts during them", async () => {
    saved({ on: true });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    await gesture();
    run("ana", { type: "castVote", card: "5" });
    run("ben", { type: "castVote", card: "8" });
    await show(run("me", { type: "reveal" }));
    const made = audioContext().sources.slice();
    await show(run("me", { type: "startRound", subject: { kind: "none" } }));
    expect(made.at(-1)?.stop).toHaveBeenCalledWith();
  });

  it("lets the volume change only while it is on, and shows it", async () => {
    saved({ on: true, volume: 0.6 });
    reloadSoundPrefs();
    render(<SoundControl />);
    await gesture();
    open();
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Volume" });
    expect(slider.value).toBe("60");
    expect(screen.getByRole("status").textContent).toContain("60");
    fireEvent.change(slider, { target: { value: "25" } });
    expect(savedPrefs()).toEqual({ on: true, volume: 0.25 });
    fireEvent.click(screen.getByRole("switch"));
    expect(slider.disabled).toBe(true);
  });

  it("shows a crossed speaker at volume 0, sound on or not", async () => {
    saved({ on: true, volume: 0 });
    reloadSoundPrefs();
    render(<SoundControl />);
    expect(button()?.querySelector("svg")?.classList).toContain("lucide-volume-x");
  });

  it("shuts when it leaves the page", async () => {
    saved({ on: true });
    reloadSoundPrefs();
    const { unmount } = render(<SoundControl />);
    await gesture();
    const audio = audioContext();
    unmount();
    expect(audio.closed).toBe(true);
  });

  it.each([
    ["fr", "Effets sonores : désactivés", "Jouer les effets sonores"],
    ["de", "Soundeffekte: aus", "Soundeffekte abspielen"],
  ] as const)("speaks %s", async (language, name, enable) => {
    await act(() => changeLanguage(language));
    render(<SoundControl />);
    expect(said()).toBe(name);
    open();
    expect(screen.getByRole("switch", { name: enable })).toBeTruthy();
  });
});

describe("the header's sound button", () => {
  afterEach(cleanup);

  it("waits for the viewer to be in the room", async () => {
    window.localStorage.clear();
    reloadSoundPrefs();
    const run = story();
    const outsider = run("ana", { type: "join", name: "Ana", role: "voter" });
    useRoomStore.setState({ snapshot: outsider, status: "live" });
    render(<RoomSoundButton />);
    expect(button()).toBeNull();

    await show(run("me", { type: "join", name: "Me", role: "voter" }));
    await waitFor(() => expect(button()).not.toBeNull());
  });
});
