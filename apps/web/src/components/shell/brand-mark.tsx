/** The logo: a spruce card tilted against a brass one. Decorative, hidden from screen readers. */
export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[26px] w-[19px] flex-none -rotate-6 rounded-[4px] bg-spruce shadow-[3px_-2px_0_-0.5px_var(--brass)]"
    />
  );
}
