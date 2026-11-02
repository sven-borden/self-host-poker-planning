import { apply, type Command, createRoom, type RoomState } from "@pp/domain";
import { type Snapshot, toSnapshot } from "@pp/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ARROW_SETTLE_MS } from "../components/ui/segment.ts";
import { changeLanguage, loadLanguage } from "../i18n/i18n.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { audioContext, FakeAudioContext, fakeAudio } from "./fake-audio.ts";
import { RoomSoundButton } from "./sound-button.tsx";
import SoundControl from "./sound-control.tsx";
import { shut } from "./sound-engine.ts";
import type { Mood } from "./sound-prefs.ts";
import { reloadSoundPrefs, SOUND_STORAGE_KEY, setSoundPrefs } from "./sound-prefs.ts";
import { SOUNDS } from "./sound-recipes.ts";

const renderLoop = vi.hoisted(() =>
  vi.fn(async (mood: Mood) => ({ duration: 48, mood }) as unknown as AudioBuffer),
);
// jsdom has no OfflineAudioContext; e2e/sound.spec.ts renders the real thing.
vi.mock("./music-render.ts", () => ({ renderLoop }));

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
    // A reset, not a clear: a held render a test never reached stays queued through a clear,
    // and the next test's first render would wait for it for ever.
    renderLoop.mockReset();
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
    expect(said()).toBe("Sound: off");
    await gesture();
    await show(run("ana", { type: "castVote", card: "5" }));
    await show(run("me", { type: "reveal" }));
    await gesture();
    expect(FakeAudioContext.made).toEqual([]);
    expect(renderLoop).not.toHaveBeenCalled();
  });

  it("turns on from its switch, heard at once, and is remembered", async () => {
    render(<SoundControl />);
    open();
    fireEvent.click(screen.getByRole("switch", { name: "Play sound effects" }));
    await waitFor(() => expect(audioContext().state).toBe("running"));
    expect(audioContext().sources).toHaveLength(SOUNDS.card.length);
    expect(button()?.dataset.sound).toBe("on");
    expect(savedPrefs()).toMatchObject({ on: true });

    fireEvent.click(screen.getByRole("switch", { name: "Play sound effects" }));
    expect(audioContext().closed).toBe(true);
    expect(said()).toBe("Sound: off");
  });

  it("stays silent after a reload until a gesture, and misses what came before it", async () => {
    saved({ on: true, volume: 0.5 });
    reloadSoundPrefs();
    const run = room();
    render(<SoundControl />);
    expect(said()).toBe("Sound: on, from your first click or key press");
    await show(run("ana", { type: "castVote", card: "5" }));
    await show(run("me", { type: "reveal" }));
    expect(FakeAudioContext.made).toEqual([]);

    await gesture();
    expect(audioContext().state).toBe("running");
    expect(said()).toBe("Sound: on");
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
    expect(slider.getAttribute("aria-valuetext")).toContain("60");
    expect(document.querySelector("[data-sound-level]")?.textContent).toContain("60");
    fireEvent.change(slider, { target: { value: "25" } });
    expect(savedPrefs()).toMatchObject({ on: true, volume: 0.25 });
    fireEvent.click(screen.getByRole("switch", { name: "Play sound effects" }));
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
    ["fr", "Son : désactivé", "Jouer les effets sonores", "Jouer la musique de fond", "Marée"],
    ["de", "Ton: aus", "Soundeffekte abspielen", "Hintergrundmusik abspielen", "Gezeiten"],
  ] as const)("speaks %s", async (language, name, enable, music, mood) => {
    await act(() => changeLanguage(language));
    render(<SoundControl />);
    expect(said()).toBe(name);
    open();
    expect(screen.getByRole("switch", { name: enable })).toBeTruthy();
    expect(screen.getByRole("switch", { name: music })).toBeTruthy();
    expect(screen.getByRole("radio", { name: mood })).toBeTruthy();
  });

  describe("the music", () => {
    const musicSwitch = () => screen.getByRole("switch", { name: "Play background music" });
    /** What the loop's source is: the only source, with the effects off. */
    const source = () => audioContext().sources[0];
    const playing = () => waitFor(() => expect(source()?.loop).toBe(true));

    function musicOn(mood?: Mood) {
      saved({ music: true, mood });
      reloadSoundPrefs();
    }

    it("is off by default, and renders nothing with the effects on", async () => {
      saved({ on: true });
      reloadSoundPrefs();
      room();
      render(<SoundControl />);
      await gesture();
      await show(story()("me", { type: "join", name: "Me", role: "voter" }));
      open();
      expect(musicSwitch().getAttribute("aria-checked")).toBe("false");
      expect(renderLoop).not.toHaveBeenCalled();
    });

    it("plays from its switch while voting is open, with the effects off", async () => {
      room();
      render(<SoundControl />);
      open();
      fireEvent.click(musicSwitch());
      await playing();
      expect(FakeAudioContext.made).toHaveLength(1);
      expect(audioContext().sources).toHaveLength(1);
      expect(renderLoop).toHaveBeenCalledWith("dusk");
      expect(said()).toBe("Sound: on");
      expect(savedPrefs()).toMatchObject({ on: false, music: true });
    });

    it("waits for voting, and fades out on the reveal", async () => {
      musicOn();
      const run = story();
      run("me", { type: "join", name: "Me", role: "voter" });
      run("ana", { type: "join", name: "Ana", role: "voter" });
      useRoomStore.setState({
        snapshot: run("me", { type: "updateSettings", patch: { revealWhenAllVoted: false } }),
      });
      render(<SoundControl />);
      await gesture();
      await waitFor(() => expect(renderLoop).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve));
      expect(audioContext().sources).toEqual([]);

      await show(run("me", { type: "startRound", subject: { kind: "none" } }));
      await playing();
      await show(run("me", { type: "reveal" }));
      const stop = source()?.stop;
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop?.mock.calls[0]).toHaveLength(1);

      await show(run("me", { type: "startRound", subject: { kind: "none" } }));
      expect(audioContext().sources).toHaveLength(2);
      expect(renderLoop).toHaveBeenCalledTimes(1);
    });

    it("keeps playing through votes and a timer", async () => {
      musicOn();
      const run = room();
      render(<SoundControl />);
      await gesture();
      await playing();
      await show(run("me", { type: "startTimer", seconds: 60 }));
      await show(run("ana", { type: "castVote", card: "5" }));
      expect(source()?.stop).not.toHaveBeenCalled();
      expect(audioContext().sources).toHaveLength(1);
    });

    it("stays silent after a reload until a gesture, rendering nothing", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      expect(said()).toBe("Sound: on, from your first click or key press");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(FakeAudioContext.made).toEqual([]);
      expect(renderLoop).not.toHaveBeenCalled();
      await gesture();
      await playing();
      expect(said()).toBe("Sound: on");
    });

    it("keeps the context for the music when the effects go off", async () => {
      saved({ on: true, music: true });
      reloadSoundPrefs();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      fireEvent.click(screen.getByRole("switch", { name: "Play sound effects" }));
      expect(audioContext().closed).toBe(false);
      expect(source()?.stop).not.toHaveBeenCalled();
      expect(said()).toBe("Sound: on");
    });

    it("keeps the context for the effects when the music goes off", async () => {
      saved({ on: true, music: true });
      reloadSoundPrefs();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      fireEvent.click(musicSwitch());
      expect(source()?.stop).toHaveBeenCalledTimes(1);
      source()?.onended?.();
      expect(audioContext().closed).toBe(false);
      expect(said()).toBe("Sound: on");
    });

    it("fades out when turned off, and only then gives the device back", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      fireEvent.click(musicSwitch());
      expect(said()).toBe("Sound: off");
      expect(audioContext().closed).toBe(false);
      expect(source()?.stop.mock.calls[0]).toHaveLength(1);
      source()?.onended?.();
      expect(audioContext().closed).toBe(true);
    });

    it("fades out when the viewer leaves the room", async () => {
      musicOn();
      room();
      const { unmount } = render(<SoundControl />);
      await gesture();
      await playing();
      const audio = audioContext();
      unmount();
      expect(audio.closed).toBe(false);
      expect(source()?.stop.mock.calls[0]).toHaveLength(1);
      source()?.onended?.();
      expect(audio.closed).toBe(true);
    });

    it("keeps the sound when it comes back during the fall, with no gesture", async () => {
      musicOn();
      room();
      const first = render(<SoundControl />);
      await gesture();
      await playing();
      const audio = audioContext();
      const leaving = source();
      first.unmount();
      expect(leaving?.stop).toHaveBeenCalledTimes(1);

      render(<SoundControl />);
      await waitFor(() => expect(audio.sources).toHaveLength(2));
      leaving?.onended?.();
      expect(audio.closed).toBe(false);
      expect(audio.sources[1]?.stop).not.toHaveBeenCalled();
      expect(said()).toBe("Sound: on");
    });

    it("keeps the sound when another tab turns the music off and on", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      const audio = audioContext();
      act(() => setSoundPrefs({ music: false }));
      act(() => setSoundPrefs({ music: true }));
      await waitFor(() => expect(audio.sources).toHaveLength(2));
      source()?.onended?.();
      expect(audio.closed).toBe(false);
      expect(said()).toBe("Sound: on");
    });

    /** A render held back: the mood's loop, when `finish` is called. */
    function heldRender(mood: Mood) {
      let finish = () => {};
      renderLoop.mockReturnValueOnce(
        new Promise<AudioBuffer>((resolve) => {
          finish = () => resolve({ duration: 48, mood } as unknown as AudioBuffer);
        }),
      );
      return () => finish();
    }

    it("plays the old mood on until the new one is ready, then fades one under the other", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      const audio = audioContext();
      const [, oldFade, ...none] = audio.gains;
      expect(none).toEqual([]);
      open();
      const finish = heldRender("tide");
      fireEvent.click(screen.getByRole("radio", { name: "Tide" }));
      expect(savedPrefs()).toMatchObject({ music: true, mood: "tide" });
      await waitFor(() => expect(renderLoop).toHaveBeenLastCalledWith("tide"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(source()?.stop).not.toHaveBeenCalled();
      expect(oldFade?.gain.setTargetAtTime).toHaveBeenCalledTimes(1);

      audio.currentTime = 30;
      finish();
      await waitFor(() => expect(audio.sources).toHaveLength(2));
      // Stopped under its fade, and the new one starts from nothing: no step in either.
      expect(source()?.stop.mock.calls[0]?.[0]).toBeGreaterThan(30);
      expect(oldFade?.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 30, expect.any(Number));
      expect(oldFade?.gain.setValueAtTime).toHaveBeenCalledTimes(1);
      const newFade = audio.gains[2]?.gain;
      expect(newFade?.setValueAtTime).toHaveBeenCalledWith(0, 30);
      expect(newFade?.setTargetAtTime).toHaveBeenCalledWith(1, 30, expect.any(Number));
      expect(audio.sources[1]?.buffer).toMatchObject({ mood: "tide" });
    });

    it("ends the old mood at a reveal while the new one renders", async () => {
      musicOn();
      const run = room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      const finish = heldRender("tide");
      fireEvent.click(screen.getByRole("radio", { name: "Tide" }));
      await waitFor(() => expect(renderLoop).toHaveBeenLastCalledWith("tide"));
      await show(run("me", { type: "reveal" }));
      expect(source()?.stop).toHaveBeenCalledTimes(1);
      finish();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(audioContext().sources).toHaveLength(1);
    });

    it("follows a reveal that arrives as the mood changes", async () => {
      musicOn();
      const run = room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      heldRender("tide");
      await act(async () => {
        useRoomStore.setState({ snapshot: run("me", { type: "reveal" }) });
        fireEvent.click(screen.getByRole("radio", { name: "Tide" }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(source()?.stop).toHaveBeenCalledTimes(1);
    });

    it("waits for the arrow keys to rest, and a click acts at once", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      renderLoop.mockClear();
      const radio = (name: string) => screen.getByRole<HTMLInputElement>("radio", { name });
      fireEvent.keyDown(radio("Dusk"), { key: "ArrowRight" });
      fireEvent.click(radio("Tide"));
      fireEvent.keyDown(radio("Tide"), { key: "ArrowRight" });
      fireEvent.click(radio("Embers"));
      expect(radio("Embers").checked).toBe(true);
      expect(savedPrefs()).toMatchObject({ mood: "embers" });
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(renderLoop).not.toHaveBeenCalled();
      await act(() => new Promise((resolve) => setTimeout(resolve, ARROW_SETTLE_MS)));
      await waitFor(() => expect(renderLoop).toHaveBeenCalledTimes(1));
      expect(renderLoop).toHaveBeenLastCalledWith("embers");

      fireEvent.pointerDown(radio("Tide"));
      fireEvent.click(radio("Tide"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(renderLoop).toHaveBeenCalledTimes(2);
      expect(renderLoop).toHaveBeenLastCalledWith("tide");
    });

    it("renders nothing for arrow keys that come back to where they began", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      renderLoop.mockClear();
      const radio = (name: string) => screen.getByRole("radio", { name });
      fireEvent.keyDown(radio("Dusk"), { key: "ArrowRight" });
      fireEvent.click(radio("Tide"));
      fireEvent.keyDown(radio("Tide"), { key: "ArrowLeft" });
      fireEvent.click(radio("Dusk"));
      await act(() => new Promise((resolve) => setTimeout(resolve, ARROW_SETTLE_MS + 50)));
      expect(renderLoop).not.toHaveBeenCalled();
    });

    it("waits for a quiet moment before it renders", async () => {
      const idle: Array<() => void> = [];
      const ask = vi.fn((work: () => void, _options: IdleRequestOptions) => idle.push(work));
      vi.stubGlobal("requestIdleCallback", ask);
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      expect(ask.mock.calls[0]?.[1]).toMatchObject({ timeout: expect.any(Number) });
      expect(renderLoop).not.toHaveBeenCalled();
      idle.shift()?.();
      await playing();
      expect(renderLoop).toHaveBeenCalledTimes(1);
    });

    it("drops a mood rendered too late", async () => {
      let finish = (_: AudioBuffer) => {};
      renderLoop.mockReturnValueOnce(
        new Promise<AudioBuffer>((resolve) => {
          finish = resolve;
        }),
      );
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await waitFor(() => expect(renderLoop).toHaveBeenCalledTimes(1));
      open();
      fireEvent.click(screen.getByRole("radio", { name: "Embers" }));
      await waitFor(() => expect(audioContext().sources).toHaveLength(1));
      finish({ duration: 48 } as AudioBuffer);
      await new Promise((resolve) => setTimeout(resolve));
      expect(audioContext().sources).toHaveLength(1);
      expect(source()?.buffer).toMatchObject({ mood: "embers" });
    });

    it("costs nothing but the music when its chunk fails", async () => {
      renderLoop.mockRejectedValueOnce(new Error("chunk gone"));
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await waitFor(() => expect(renderLoop).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve));
      expect(audioContext().sources).toEqual([]);
      expect(said()).toBe("Sound: on");
    });

    it("asks again at the next gesture after a failed render", async () => {
      renderLoop.mockRejectedValueOnce(new Error("chunk gone"));
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await waitFor(() => expect(renderLoop).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve));
      await gesture();
      await playing();
      expect(renderLoop).toHaveBeenCalledTimes(2);
    });

    it("asks again at the next round after a failed render", async () => {
      renderLoop.mockRejectedValueOnce(new Error("chunk gone"));
      musicOn();
      const run = room();
      await act(async () => {
        useRoomStore.setState({ snapshot: run("me", { type: "reveal" }) });
      });
      render(<SoundControl />);
      await gesture();
      await waitFor(() => expect(renderLoop).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve));
      await show(run("me", { type: "startRound", subject: { kind: "none" } }));
      await playing();
      expect(renderLoop).toHaveBeenCalledTimes(2);
    });

    it("renders once however many gestures follow", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      await gesture();
      await gesture();
      expect(renderLoop).toHaveBeenCalledTimes(1);
    });

    it("offers the moods only while the music is on", async () => {
      musicOn("embers");
      room();
      render(<SoundControl />);
      open();
      const embers = screen.getByRole<HTMLInputElement>("radio", { name: "Embers" });
      expect(embers.checked).toBe(true);
      expect(embers.disabled).toBe(false);
      fireEvent.click(musicSwitch());
      expect(embers.disabled).toBe(true);
    });

    it("moves the volume without a card's sound when only the music is on", async () => {
      musicOn();
      room();
      render(<SoundControl />);
      await gesture();
      await playing();
      open();
      const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Volume" });
      expect(slider.disabled).toBe(false);
      fireEvent.change(slider, { target: { value: "25" } });
      expect(savedPrefs()).toMatchObject({ volume: 0.25 });
      expect(audioContext().sources).toHaveLength(1);
    });

    it("shows a speaker while only the music is on", () => {
      saved({ music: true, volume: 0.5 });
      reloadSoundPrefs();
      render(<SoundControl />);
      expect(button()?.querySelector("svg")?.classList).toContain("lucide-volume-2");
    });
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
