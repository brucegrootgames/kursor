import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { onUiEvent } from './store';

/** Seconds elapsed since `startedAt`, ticking once a second while `active`. */
export function useElapsedSeconds(startedAt: number, endedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const end = endedAt ?? (active ? now : startedAt);
  return Math.max(0, Math.round((end - startedAt) / 1000));
}

/**
 * Keeps a scroll container pinned to the bottom while the user is near the bottom.
 * Returns whether we are currently pinned, plus a function to force-scroll.
 */
export function useStickToBottom(ref: RefObject<HTMLElement>, deps: unknown[]): { pinned: boolean; scrollToBottom(): void } {
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const p = dist < 48;
      if (p !== pinnedRef.current) {
        pinnedRef.current = p;
        setPinned(p);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  // Re-pin when content grows (ResizeObserver on the first child) and on deps change.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    const inner = el.firstElementChild;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(
    () =>
      onUiEvent((e) => {
        if (e.type === 'scrollToBottom') {
          pinnedRef.current = true;
          setPinned(true);
          const el = ref.current;
          if (el) el.scrollTop = el.scrollHeight;
        }
      }),
    [ref],
  );

  return {
    pinned,
    scrollToBottom: () => {
      pinnedRef.current = true;
      setPinned(true);
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
  };
}

/** Grow a textarea with its content up to `maxPx`. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement>, value: string, maxPx = 220): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(maxPx, el.scrollHeight);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
  }, [ref, value, maxPx]);
}
