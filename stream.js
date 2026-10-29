// Client side of the stream protocol that streamToChannel() (./server.js)
// speaks. Kept identical in @hibira-io/react and @hibira-io/vue.
//
// A stream is a run of events on one channel, all with the same event name
// (default "ai-stream") and payloads like:
//
//   { id, seq: 0, delta: "Hel", meta? }   first chunk, meta only here
//   { id, seq: 1, delta: "lo" }
//   { id, seq: 2, done: true, text? }     last; text = the whole text when it fits
//   { id, seq: 2, done: true, error }     the source failed
//
// Chunks are applied in seq order, so one that arrives early waits for the
// gap to fill. A client that subscribed late, or lost its connection for a
// while, misses chunks: the final event's text (sent when the whole text fits
// in one message) puts it right, and otherwise the stream ends with
// incomplete: true.

export const STREAM_EVENT = 'ai-stream';

/**
 * Applies stream events to a map of streams by id.
 * `onChange(streams, stream)` runs after each event that changed something,
 * with a new `streams` object (streams themselves are replaced, not mutated).
 */
export function createStreamStore(onChange, { maxStreams = 50 } = {}) {
  let streams = {};
  const pending = new Map(); // id -> { next, early: Map<seq, payload> }

  function apply(payload) {
    if (!payload || typeof payload !== 'object' || payload.id == null) return;
    const id = String(payload.id);
    const seq = Number(payload.seq);
    let state = pending.get(id);
    let s = streams[id];
    if (!state) {
      if (s && s.done) return; // a late duplicate of a finished stream
      // First event we see for this id. When it is not seq 0 we joined late.
      state = { next: Number.isFinite(seq) ? seq : 0, early: new Map(), gap: Number.isFinite(seq) && seq > 0 };
      pending.set(id, state);
    }
    if (!Number.isFinite(seq) || seq < state.next) return; // duplicate
    state.early.set(seq, payload);

    s = s ?? { id, text: '', done: false, error: null, meta: null, incomplete: false, startedAt: Date.now() };
    let changed = false;
    while (state.early.has(state.next)) {
      const p = state.early.get(state.next);
      state.early.delete(state.next);
      state.next++;
      changed = true;
      s = { ...s };
      if (p.meta !== undefined && s.meta == null) s.meta = p.meta;
      if (typeof p.delta === 'string') s.text += p.delta;
      if (p.done) {
        if (typeof p.text === 'string') s.text = p.text;
        else if (state.gap) s.incomplete = true;
        if (p.error != null) s.error = String(p.error);
        s.done = true;
        s.endedAt = Date.now();
        pending.delete(id);
        break;
      }
    }
    // A done event that waits behind a gap which will never fill (we missed
    // those chunks) still finishes the stream when it carries the whole text.
    if (!changed && payload.done && typeof payload.text === 'string') {
      s = { ...s, text: payload.text, done: true, error: payload.error != null ? String(payload.error) : null, endedAt: Date.now() };
      pending.delete(id);
      changed = true;
    }
    if (!changed) return;
    streams = { ...streams, [id]: s };
    const ids = Object.keys(streams);
    if (ids.length > maxStreams) {
      for (const old of ids.slice(0, ids.length - maxStreams)) {
        delete streams[old];
        pending.delete(old);
      }
    }
    onChange(streams, s);
  }

  return {
    apply,
    get streams() {
      return streams;
    },
    reset() {
      streams = {};
      pending.clear();
      onChange(streams, null);
    },
  };
}

/** The stream that started last, or null. */
export function latestStream(streams) {
  let latest = null;
  for (const id in streams) {
    const s = streams[id];
    if (!latest || s.startedAt >= latest.startedAt) latest = s;
  }
  return latest;
}
