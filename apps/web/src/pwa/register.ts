/**
 * Starts the service worker (#46, ADR-022) once the page has loaded, so its first fetches
 * never compete with the page's own. Only in a build: in development Vite's files have no
 * `/sw.js`. `updateViaCache: "none"` asks the server for the script at every check, whatever
 * a proxy between them says. A refusal changes nothing: the app needs no worker to run.
 */
export function registerServiceWorker(container = globalThis.navigator?.serviceWorker) {
  if (!import.meta.env.PROD || !container) return;
  const register = () => {
    container.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
