import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusSoon } from "./focus.ts";

// A placed focus (#43): what it waits for, and what it replaces, may draw a step behind the
// table, so it looks again each frame for a while, unless the person moved the focus.

describe("focusSoon", () => {
  let frames: FrameRequestCallback[] = [];
  const nextFrame = () => {
    const due = frames;
    frames = [];
    for (const frame of due) frame(0);
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  const add = (id: string) => {
    const button = document.createElement("button");
    button.id = id;
    document.body.append(button);
    return button;
  };

  it("waits for a target that draws a few frames later", () => {
    focusSoon("#later");
    nextFrame();
    nextFrame();
    const later = add("later");
    nextFrame();
    expect(document.activeElement).toBe(later);
    expect(frames).toHaveLength(0);
  });

  it("leaves a focus the person placed meanwhile", () => {
    focusSoon("#later");
    nextFrame();
    const theirs = add("theirs");
    theirs.focus();
    add("later");
    nextFrame();
    expect(document.activeElement).toBe(theirs);
    expect(frames).toHaveLength(0);
  });

  it("waits for the pressed button to leave, then takes over", () => {
    const pressed = add("pressed");
    pressed.focus();
    const hand = add("hand");
    focusSoon("#hand");
    nextFrame();
    expect(document.activeElement).toBe(pressed);
    pressed.remove();
    nextFrame();
    expect(document.activeElement).toBe(hand);
  });

  it("leaves the focus on a control that keeps it", () => {
    const field = add("field");
    field.focus();
    add("hand");
    focusSoon("#hand");
    for (let i = 0; i < 40; i += 1) nextFrame();
    expect(document.activeElement).toBe(field);
    expect(frames).toHaveLength(0);
  });

  it("gives up on a target that never comes", () => {
    focusSoon("#never");
    for (let i = 0; i < 40; i += 1) nextFrame();
    expect(frames).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });
});
