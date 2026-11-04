// Sonner removes a dismissed toast 200 ms later, from a timer nothing clears: when the last
// test of a file dismisses one (the "reconnecting" toast goes when the identity settles) and
// the file ends first, the timer fires in the torn-down environment and React reads
// `window.event`: "window is not defined", an unhandled error that fails the whole run. Call
// this in `afterAll` of every test file that renders the app (which holds the toaster), after
// `cleanup`, so no sonner timer outlives the file.
const SONNER_TIME_BEFORE_UNMOUNT_MS = 200;

export function settleToasts(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SONNER_TIME_BEFORE_UNMOUNT_MS + 100));
}
