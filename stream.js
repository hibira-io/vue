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
//
// With channel history on (Hobby plans and up, turned on in the app's
// settings), followStream() closes those gaps: each time the channel is
// subscribed, first or again after a dropped connection, it asks the server
// for the events it missed with pusher:rewind. A page reloaded halfway
// through an answer picks the whole answer up again.

export const STREAM_EVENT = 'ai-stream';

/** Seconds of slack added to the gap asked for after a reconnect. */
export const REWIND_SLACK = 2;

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

/**
 * Feeds a channel's stream events to `apply(payload)`; with `rewind`, also
 * the ones missed before subscribing or while disconnected.
 *
 * On each subscription it sends pusher:rewind for the last `seconds` (the
 * first time) or for the time since the last stream event plus a little
 * slack (after a reconnect). Events that arrive while the answer is pending
 * are held, then applied grouped by payload id (groups in the order they
 * first arrived, each in seq order; payloads without seq keep their order),
 * so a stream that started before the page loaded is rebuilt from its first
 * chunk. Duplicates the slack brings back are left to `apply`: the stream
 * store drops them by seq.
 *
 * @param {object} channel pusher-js channel
 * @param {object} options
 * @param {(payload, event) => void} options.apply
 * @param {string|string[]} [options.event="ai-stream"] one event name or several
 * @param {boolean|object} [options.rewind] true, or { seconds = 300, limit, timeout = 5000 }
 * @param {object} [options.client] pusher-js client; default channel.pusher
 * @param {(result) => void} [options.onHistory] gets pusher:rewind_succeeded's
 *   { count, window, complete }, or { error } when history is off, not in
 *   the plan, or the answer timed out
 * @returns {() => void} stops following
 */
export function followStream(channel, { apply, event = STREAM_EVENT, rewind, client, onHistory, now = Date.now } = {}) {
  const opts = rewind ? { seconds: 300, limit: 0, timeout: 5000, ...(rewind === true ? {} : rewind) } : null;
  let last = null;
  let held = null;
  let timer = null;

  const events = Array.isArray(event) ? event : [event];
  const handlers = events.map((name) => [
    name,
    (payload) => {
      last = now();
      if (held) held.push([payload, name]);
      else apply(payload, name);
    },
  ]);
  const flush = (result) => {
    if (!held) return;
    clearTimeout(timer);
    const list = held;
    held = null;
    const byId = new Map();
    for (const item of list) {
      const key = String(item[0]?.id);
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(item);
    }
    for (const group of byId.values()) {
      group.sort(([a], [b]) => (Number(a?.seq) - Number(b?.seq)) || 0).forEach(([p, name]) => apply(p, name));
    }
    onHistory?.(result);
  };
  const start = () => {
    const pusher = client ?? channel.pusher;
    if (!pusher?.send_event) return;
    const seconds = last == null ? opts.seconds : Math.ceil((now() - last) / 1000) + REWIND_SLACK;
    held = held ?? [];
    const data = { channel: channel.name, seconds };
    if (opts.limit > 0) data.limit = opts.limit;
    pusher.send_event('pusher:rewind', data, channel.name);
    clearTimeout(timer);
    timer = setTimeout(() => flush({ error: 'Channel history did not answer in time' }), opts.timeout);
  };
  const onDone = (data) => flush({ count: data?.count ?? 0, window: data?.window ?? 0, complete: data?.complete !== false });
  const onError = (data) => flush({ error: data?.error ?? data?.type ?? 'Channel history is unavailable' });

  for (const [name, fn] of handlers) channel.bind(name, fn);
  if (opts) {
    channel.bind('pusher:subscription_succeeded', start);
    channel.bind('pusher:rewind_succeeded', onDone);
    channel.bind('pusher:rewind_error', onError);
    if (channel.subscribed) start();
  }
  return () => {
    for (const [name, fn] of handlers) channel.unbind(name, fn);
    if (!opts) return;
    channel.unbind('pusher:subscription_succeeded', start);
    channel.unbind('pusher:rewind_succeeded', onDone);
    channel.unbind('pusher:rewind_error', onError);
    clearTimeout(timer);
    held = null;
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
