import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { useRoomStore } from "../stores/room-store.ts";
import { describeEvents, type LiveEvent, liveEvents, mergeEvents } from "./announcements.ts";

/** A batch is said once nothing new came for this long… */
export const LIVE_QUIET_MS = 600;
/** …or this long after its first event, so a steady stream is still heard. */
export const LIVE_MAX_WAIT_MS = 1500;

/**
 * The table's polite live region (#17): "Ana joined.", "Ben is away.", "Ana voted.", or
 * "3 people voted." for a burst. It follows every snapshot the room store keeps (not each
 * render, which could merge two), reads its causes (and, for a snapshot without any, the
 * reveal it shows), and batches what they say. What it says is kept in the store's `said`:
 * the settings panel (#25), which hides the page from screen readers while it is open,
 * says the same words in a region of its own.
 */
export function LiveAnnouncer() {
  const t = useT();
  const tRef = useRef(t);
  const said = useRoomStore((state) => state.said);
  // Only what is said from now on: a region that appears with words in it says nothing.
  const [since] = useState(() => useRoomStore.getState().said.id);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    let pending: LiveEvent[] = [];
    let firstAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const text = describeEvents(tRef.current, pending);
      pending = [];
      if (text !== "") useRoomStore.getState().announce(text);
    };
    const unsubscribe = useRoomStore.subscribe((state, before) => {
      const next = state.snapshot;
      // No causes is not nothing: a reconnect's snapshot can show the reveal it missed.
      if (!next || next === before.snapshot) return;
      const previous = before.snapshot?.room.code === next.room.code ? before.snapshot.room : null;
      const events = liveEvents(next.room, next.causes, previous);
      if (events.length === 0) return;
      if (pending.length === 0) firstAt = Date.now();
      pending = mergeEvents(pending, events);
      clearTimeout(timer);
      const wait = Math.min(LIVE_QUIET_MS, Math.max(0, firstAt + LIVE_MAX_WAIT_MS - Date.now()));
      timer = setTimeout(flush, wait);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  // A new element per announcement: the same words twice in a row are still read out.
  return (
    <div role="status" data-table-live className="sr-only">
      <span key={said.id}>{said.id > since ? said.text : ""}</span>
    </div>
  );
}
