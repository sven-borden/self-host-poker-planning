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
 * render, which could merge two), reads its causes, and batches what they say.
 */
export function LiveAnnouncer() {
  const t = useT();
  const tRef = useRef(t);
  const [said, setSaid] = useState({ id: 0, text: "" });

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
      if (text !== "") setSaid((before) => ({ id: before.id + 1, text }));
    };
    const unsubscribe = useRoomStore.subscribe((state, before) => {
      const next = state.snapshot;
      if (!next || next === before.snapshot || next.causes.length === 0) return;
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
      <span key={said.id}>{said.text}</span>
    </div>
  );
}
