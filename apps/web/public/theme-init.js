// Applies the saved theme before first paint. Loaded as an external, blocking script in
// <head> because the Content Security Policy forbids inline scripts.
// Keep in sync with src/theme/theme.ts: same storage key, same values. Plain ES5 on
// purpose: it runs before the app bundle and must never throw.
(() => {
  var mode = null;
  var metas;
  var i;
  try {
    mode = window.localStorage.getItem("pp-theme");
  } catch (_error) {
    // Storage blocked (private mode, disabled cookies): fall back to the system theme.
  }
  if (mode === "light" || mode === "dark") {
    document.documentElement.setAttribute("data-theme", mode);
    // A phone's bar follows the saved theme, not the system's (`applyThemeColour`).
    metas = document.querySelectorAll('meta[name="theme-color"]');
    for (i = 0; i < metas.length; i += 1) {
      metas[i].setAttribute(
        "media",
        metas[i].getAttribute("data-scheme") === mode ? "all" : "not all",
      );
    }
  }
})();
