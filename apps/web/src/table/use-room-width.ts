import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * The width of the element behind the ref, in pixels, kept current by a ResizeObserver;
 * null until it is first measured (before the first paint). The table reads the room
 * its container gives it, so its variant follows the page, not the viewport.
 */
export function useRoomWidth<T extends Element>(): [RefObject<T | null>, number | null] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const read = () => setWidth(element.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
