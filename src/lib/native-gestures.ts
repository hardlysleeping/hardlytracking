/**
 * The handful of browser gestures that make an app feel like a web page.
 *
 * A WKWebView is a browser: it offers a double-tap zoom, a pinch zoom, a long-press callout with
 * Copy / Look Up / Share on any text it can select, a tap highlight, and image dragging. None of
 * those exist in a native iOS app, and each one is a small "this is a website" tell.
 *
 * Three layers, because no single one covers iOS:
 *
 * 1. **The viewport** (`index.html`) says `maximum-scale=1, user-scalable=no`. Safari ignores it
 *    since iOS 10; a packaged WKWebView honours it, so it is the cheap first line.
 * 2. **CSS** (`app.css`) turns off selection, the callout, the tap highlight and image dragging on
 *    the chrome, and turns selection back on for the few places it belongs (a text field, an error
 *    message worth copying, anything marked `.selectable`).
 * 3. **This file** cancels the gestures CSS cannot: a second tap inside the double-tap window, and
 *    the non-standard `gesturestart`/`gesturechange` pair WebKit fires for a pinch.
 *
 * **`touch-action: manipulation` alone is not enough on iOS.** It removes the 300 ms delay and the
 * double-tap zoom in Chrome, and iOS honours it for the delay only — the zoom still happens. Hence
 * the tap pair check here.
 *
 * Nothing here touches scrolling, the reader's panes, drag-to-reorder or a long press that the app
 * owns: those listen for their own pointer events and cancel what they handle.
 */

/** How long two taps may be apart and still count as one double tap (ms). iOS uses ~300. */
export const DOUBLE_TAP_MS = 320;
/** How far apart two taps may land and still be the same spot (px). */
export const DOUBLE_TAP_SLOP = 30;

export interface Tap {
  time: number;
  x: number;
  y: number;
}

/**
 * Is this tap the second half of a double tap?
 *
 * Pure so the rule is testable without a browser: same-ish place, inside the window. A tap that
 * moves more than `DOUBLE_TAP_SLOP` is a different gesture (a second tap on another row, a swipe
 * that ended), and cancelling it would swallow a real press.
 */
export function isDoubleTap(previous: Tap | null, next: Tap, maxMs: number = DOUBLE_TAP_MS): boolean {
  if (previous === null) return false;
  const elapsed = next.time - previous.time;
  if (elapsed < 0 || elapsed > maxMs) return false;
  return Math.abs(next.x - previous.x) <= DOUBLE_TAP_SLOP && Math.abs(next.y - previous.y) <= DOUBLE_TAP_SLOP;
}

/** Where a touch or a pointer landed, in the shape `isDoubleTap` takes. */
export function tapOf(event: Event, time: number): Tap {
  const point = event as unknown as { clientX?: number; clientY?: number; changedTouches?: ArrayLike<{ clientX: number; clientY: number }> };
  const touch = point.changedTouches?.[0];
  if (touch !== undefined) return { time, x: touch.clientX, y: touch.clientY };
  return { time, x: point.clientX ?? 0, y: point.clientY ?? 0 };
}

export interface GestureTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions | boolean): void;
}

/**
 * Install the gesture guards. Returns a disposer, which the tests use and a hot reload needs.
 *
 * `now` is injectable so a test can drive the tap window instead of sleeping.
 */
export function installNativeGestures(
  target: GestureTarget,
  options: { now?: () => number; doubleTapMs?: number } = {},
): () => void {
  const now = options.now ?? (() => performance.now());
  const maxMs = options.doubleTapMs ?? DOUBLE_TAP_MS;
  let lastTap: Tap | null = null;

  const onTouchEnd = (event: Event): void => {
    const tap = tapOf(event, now());
    if (isDoubleTap(lastTap, tap, maxMs)) {
      // The second tap of a double tap is the zoom. Cancel it and forget the pair, so a third tap
      // starts fresh instead of being read as another double.
      event.preventDefault();
      lastTap = null;
      return;
    }
    lastTap = tap;
  };

  const onDoubleClick = (event: Event): void => {
    event.preventDefault();
  };

  // WebKit's own pinch events. `preventDefault` on the start is what stops the page scaling.
  const onGesture = (event: Event): void => {
    event.preventDefault();
  };

  target.addEventListener("touchend", onTouchEnd, { passive: false });
  target.addEventListener("dblclick", onDoubleClick, { passive: false });
  target.addEventListener("gesturestart", onGesture, { passive: false });
  target.addEventListener("gesturechange", onGesture, { passive: false });
  target.addEventListener("gestureend", onGesture, { passive: false });

  return () => {
    target.removeEventListener("touchend", onTouchEnd);
    target.removeEventListener("dblclick", onDoubleClick);
    target.removeEventListener("gesturestart", onGesture);
    target.removeEventListener("gesturechange", onGesture);
    target.removeEventListener("gestureend", onGesture);
  };
}
