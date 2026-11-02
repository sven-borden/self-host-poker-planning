// The offline page's script (#46, ADR-022): the saved theme, the reader's language and the
// retry button. The worker can read neither of the first two, and the policy forbids inline
// scripts. Runs in <head>, blocking, so the page never shows in the wrong language; without
// it the page is English in the system's theme. Keep in sync with src/i18n/language.ts and
// src/theme/theme.ts: same keys, same rules. Plain ES5, as public/theme-init.js.
(() => {
  var root = document.documentElement;
  var primary;
  var i;

  function saved(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  var theme = saved("pp-theme");
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);

  var tags = [saved("pp-language")].concat(navigator.languages || [navigator.language]);
  for (i = 0; i < tags.length; i += 1) {
    primary = String(tags[i]).toLowerCase().split(/[-_]/)[0];
    if (primary === "gsw") primary = "de";
    if (primary === "en" || primary === "fr" || primary === "de") {
      root.lang = primary;
      break;
    }
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry]")) window.location.reload();
  });
})();
