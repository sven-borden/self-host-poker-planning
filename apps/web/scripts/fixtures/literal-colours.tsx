// A component that breaks the colour rule on purpose: check-colours.test.ts expects the
// check to fail on this directory. It sits outside src/, so `pnpm lint` never scans it.
export function BadBadge() {
  return (
    <span className="bg-red-500 text-white" style={{ borderColor: "#B0453B", color: "rgb(0 0 0)" }}>
      !
    </span>
  );
}

// Named colours and case games, which once got past the check.
export function NamedColours() {
  return (
    <div className="bg-[red] [color:crimson] fill-[navy] shadow-[0_0_0_2px_tomato]">
      <span style={{ color: "red" }}>a</span>
      <span style={{ background: "RGB(0 0 0)" }}>b</span>
      <span style={{ outlineColor: "color-mix(in srgb, var(--ink) 50%, var(--bg))" }}>c</span>
    </div>
  );
}
