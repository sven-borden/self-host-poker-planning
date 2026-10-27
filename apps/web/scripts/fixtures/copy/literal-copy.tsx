// A component that breaks the copy rule on purpose: check-copy.test.ts expects the check
// to fail on this directory. It sits outside src/, so `pnpm lint` never scans it.
export function BadDialog({ name }: { name: string }) {
  return (
    <section aria-label="Settings">
      <h2>Room settings</h2>
      <p>Hello {name}, welcome</p>
      <input placeholder={"Your name"} title={`Name`} />
      <img alt="" src="/logo.svg" />
      <span>· / 3</span>
    </section>
  );
}
