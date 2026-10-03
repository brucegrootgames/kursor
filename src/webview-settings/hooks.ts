/** Small hooks shared by the settings controls. */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Local draft for text-like inputs. The draft follows `value` from the host while the user is
 * not editing; while editing (focused) host echoes are ignored so a slow round trip never
 * clobbers keystrokes. `commit()` pushes the draft when it differs from the last known value.
 */
export function useDraft<T>(value: T, onCommit: (v: T) => void | boolean, options: { debounceMs?: number; equals?: (a: T, b: T) => boolean } = {}) {
  const { debounceMs, equals = Object.is } = options;
  const [draft, setDraftState] = useState<T>(value);
  const editing = useRef(false);
  const latestValue = useRef(value);
  const latestDraft = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  latestValue.current = value;

  useEffect(() => {
    if (!editing.current) {
      setDraftState(value);
      latestDraft.current = value;
    }
  }, [value]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** Push the draft. Returns false when `onCommit` rejected it (the caller then reverts). */
  const commit = useCallback((): boolean => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (equals(latestDraft.current, latestValue.current)) return true;
    return onCommit(latestDraft.current) !== false;
  }, [equals, onCommit]);

  const setDraft = useCallback(
    (v: T) => {
      latestDraft.current = v;
      setDraftState(v);
      if (debounceMs !== undefined) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(commit, debounceMs);
      }
    },
    [commit, debounceMs],
  );

  const begin = useCallback(() => {
    editing.current = true;
  }, []);

  const end = useCallback(() => {
    editing.current = false;
    // Accepted commits update the store synchronously (optimistic), so the `value` effect re-syncs the
    // draft on the next render; only a rejected draft has to be rolled back here.
    if (!commit()) {
      setDraftState(latestValue.current);
      latestDraft.current = latestValue.current;
    }
  }, [commit]);

  const revert = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    setDraftState(latestValue.current);
    latestDraft.current = latestValue.current;
  }, []);

  return { draft, setDraft, begin, end, commit, revert, dirty: !equals(draft, value) };
}

let idSeq = 0;
/** Stable DOM id for label/description wiring. */
export function useId(prefix: string): string {
  const ref = useRef<string | undefined>(undefined);
  if (!ref.current) {
    idSeq += 1;
    ref.current = `${prefix}-${idSeq}`;
  }
  return ref.current;
}
