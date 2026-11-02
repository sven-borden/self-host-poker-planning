/** Saves `text` as a file named `name`, through a link the page never shows. */
export function saveFile(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  // Some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
