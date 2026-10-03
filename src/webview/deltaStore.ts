/**
 * Streaming text store. `textDelta` messages append to a per-block buffer and notify
 * ONLY the component rendering that block (via useSyncExternalStore), so a delta never
 * re-renders the whole message list. The host's `chatState` snapshots stay authoritative:
 * `syncBlock` raises the buffer to the snapshot text when the snapshot is longer, and
 * `prune` drops buffers for blocks that are no longer streaming.
 */
import { useCallback, useSyncExternalStore } from 'react';

const buffers = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function notify(blockId: string): void {
  const set = listeners.get(blockId);
  if (!set) return;
  for (const l of set) l();
}

export function appendDelta(blockId: string, delta: string): void {
  if (!delta) return;
  buffers.set(blockId, (buffers.get(blockId) ?? '') + delta);
  notify(blockId);
}

/** Called for every streaming text/thinking block in a fresh `chatState`. */
export function syncBlock(blockId: string, snapshotText: string): void {
  const cur = buffers.get(blockId);
  if (cur === undefined) {
    if (snapshotText) buffers.set(blockId, snapshotText);
    return;
  }
  if (snapshotText.length > cur.length) {
    buffers.set(blockId, snapshotText);
    notify(blockId);
  }
}

/** Drop the buffers of blocks that finished streaming (their snapshot text is final). */
export function dropBlocks(ids: Iterable<string>): void {
  for (const id of ids) {
    if (buffers.delete(id)) notify(id);
  }
}

function subscribeTo(blockId: string): (cb: () => void) => () => void {
  return (cb) => {
    let set = listeners.get(blockId);
    if (!set) {
      set = new Set();
      listeners.set(blockId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) listeners.delete(blockId);
    };
  };
}

/**
 * Returns the freshest text for a block: the longer of the snapshot text and the
 * streamed buffer (both are prefixes of the same final string).
 */
export function useStreamedText(blockId: string, base: string, streaming: boolean): string {
  // Stable subscribe function per (block, streaming) so React does not resubscribe on every render.
  const subscribe = useCallback((cb: () => void) => (streaming ? subscribeTo(blockId)(cb) : noopSubscribe()), [blockId, streaming]);
  const buffered = useSyncExternalStore(subscribe, () => (streaming ? buffers.get(blockId) : undefined));
  if (!streaming || buffered === undefined) return base;
  return buffered.length > base.length ? buffered : base;
}

function noopSubscribe(): () => void {
  return () => {};
}
