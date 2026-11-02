import { afterEach, expect, it, vi } from "vitest";
import { fixedT } from "../../i18n/i18n.ts";
import { reloadAction } from "./reload-action.ts";

afterEach(() => vi.restoreAllMocks());

it("is the room's Reload label, and reloads the page", () => {
  const reload = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
  const action = reloadAction(fixedT("en"));
  expect(action.label).toBe("Reload");
  action.onClick();
  expect(reload).toHaveBeenCalledOnce();
});
