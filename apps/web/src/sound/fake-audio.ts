import { type Mock, vi } from "vitest";

// A stand-in for `AudioContext` in unit tests: jsdom has none. It follows a browser's rule,
// suspended until `resume`, and keeps what was started and stopped. e2e/sound.spec.ts runs
// the real one.

class FakeParam {
  value = 1;
  setValueAtTime: Mock = vi.fn();
  linearRampToValueAtTime: Mock = vi.fn();
  exponentialRampToValueAtTime: Mock = vi.fn();
  setTargetAtTime: Mock = vi.fn();
}

class FakeNode {
  connect: Mock = vi.fn();
  disconnect: Mock = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start: Mock = vi.fn();
  stop: Mock = vi.fn();
}

class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
  detune = new FakeParam();
}

export class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  /** The next `resume` is refused, as a browser refuses one without a gesture. */
  static refuse = false;

  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 10;
  sampleRate = 48_000;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  buffers = 0;
  closed = false;
  private readonly listeners = new Set<() => void>();

  constructor() {
    FakeAudioContext.made.push(this);
  }

  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createBufferSource() {
    return this.createOscillator();
  }
  createBiquadFilter() {
    return new FakeFilter();
  }
  createBuffer(_channels: number, length: number) {
    this.buffers += 1;
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  }
  addEventListener(_type: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners.delete(listener);
  }
  async resume() {
    if (FakeAudioContext.refuse) throw new DOMException("no gesture", "NotAllowedError");
    if (this.state !== "running") {
      this.state = "running";
      for (const listener of this.listeners) listener();
    }
  }
  async close() {
    this.closed = true;
    this.state = "closed";
  }
}

/** Puts the stand-in in place of `AudioContext`, with no context made yet. */
export function fakeAudio() {
  FakeAudioContext.made = [];
  FakeAudioContext.refuse = false;
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

/** The one context the code under test made. */
export function audioContext(): FakeAudioContext {
  const made = FakeAudioContext.made.at(-1);
  if (!made) throw new Error("no AudioContext was made");
  return made;
}
