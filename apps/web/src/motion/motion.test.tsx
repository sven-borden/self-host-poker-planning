import { cleanup, render, screen } from "@testing-library/react";
import { m } from "motion/react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionFeatures, RiseIn } from "./motion.tsx";

afterEach(() => {
  cleanup();
});

describe("RiseIn", () => {
  it("is a CSS entry animation, so the content shows without any Motion chunk", () => {
    render(<RiseIn data-testid="rise">Hello</RiseIn>);
    const element = screen.getByTestId("rise");
    expect(element.textContent).toBe("Hello");
    expect(element.getAttribute("style")).toBeNull();
    expect(element.className).toContain("animate-in");
    expect(element.className).toContain("motion-reduce:[--tw-enter-translate-y:0]");
  });

  it("staggers with an animation delay and keeps the caller's classes", () => {
    render(
      <RiseIn data-testid="rise" delay={0.1} className="max-w-2xl">
        Later
      </RiseIn>,
    );
    const element = screen.getByTestId("rise");
    expect(element.style.animationDelay).toBe("0.1s");
    expect(element.className).toContain("max-w-2xl");
  });
});

describe("MotionFeatures", () => {
  it("renders m.* children, whose features load lazily", () => {
    render(
      <MotionFeatures>
        <m.p data-testid="animated">Dealt</m.p>
      </MotionFeatures>,
    );
    expect(screen.getByTestId("animated").textContent).toBe("Dealt");
  });
});
