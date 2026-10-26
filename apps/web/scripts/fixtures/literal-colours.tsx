// A component that breaks the colour rule on purpose: check-colours.test.ts expects the
// check to fail on this directory. It sits outside src/, so `pnpm lint` never scans it.
export function BadBadge() {
  return (
    <span className="bg-red-500 text-white" style={{ borderColor: "#B0453B", color: "rgb(0 0 0)" }}>
      !
    </span>
  );
}
