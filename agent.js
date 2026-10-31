// Client side of Laravel AI SDK streams (laravel/ai), as broadcast by
// $agent->broadcastOnQueue() / broadcast() / broadcastNow(). Kept identical in
// @hibira-io/react and @hibira-io/vue.
//
// The SDK sends one event per stream event, named by its type: stream_start,
// text_delta, reasoning_delta, tool_call, tool_result, tool_approval_request,
// stream_end, error, ... Every payload has a unique `id` and, when queued, the
// run's `invocation_id`. hibira-io/laravel splits payloads over the plan's
// per-event limit into "hibira:chunk" events, joined back here.
//
// Events are deduplicated by id, so replays from channel history
// (pusher:rewind) are safe.

export const CHUNK_EVENT = 'hibira:chunk';

export const AGENT_EVENTS = [
  'stream_start',
  'stream_end',
  'text_start',
  'text_delta',
  'text_end',
  'reasoning_start',
  'reasoning_delta',
  'reasoning_end',
  'tool_call',
  'tool_result',
  'tool_approval_request',
  'citation',
  'error',
  'stream_failed',
  CHUNK_EVENT,
];

const CHUNK_TTL = 60_000;
const SEEN_MAX = 5000;

/**
 * Applies Laravel AI stream events to a map of runs by invocation id.
 * `onChange(runs, run)` runs after each event that changed something, with
 * new objects (runs are replaced, not mutated).
 */
export function createAgentStore(onChange, { maxRuns = 20, now = Date.now } = {}) {
  let runs = {};
  const seen = new Set();
  const chunks = new Map(); // chunk id -> { parts, count, at } or { done: true, at }
  let anonymous = 0;

  function joinChunk(chunk) {
    if (!chunk || chunk.id == null || !Number.isInteger(chunk.index) || !(chunk.count > 0)) return;
    const at = now();
    for (const [key, entry] of chunks) {
      if (at - entry.at > CHUNK_TTL) chunks.delete(key);
    }
    const key = String(chunk.id);
    let entry = chunks.get(key);
    if (entry?.done) return;
    if (!entry) {
      entry = { parts: new Array(chunk.count), received: 0, at };
      chunks.set(key, entry);
    }
    if (entry.parts[chunk.index] === undefined) {
      entry.parts[chunk.index] = String(chunk.data ?? '');
      entry.received++;
    }
    if (entry.received < chunk.count) return;
    chunks.set(key, { done: true, at });
    let payload;
    try {
      payload = JSON.parse(entry.parts.join(''));
    } catch {
      return;
    }
    apply(payload, chunk.event);
  }

  function runKey(payload, type) {
    if (payload.invocation_id != null) return String(payload.invocation_id);
    // broadcast()/broadcastNow() outside the queue send no invocation id: a
    // stream_start after a finished run begins the next one.
    const current = runs[`run-${anonymous}`];
    if (!current || (type === 'stream_start' && current.done)) anonymous++;
    return `run-${anonymous}`;
  }

  function apply(payload, event) {
    if (!payload || typeof payload !== 'object') return;
    if (event === CHUNK_EVENT) {
      joinChunk(payload);
      return;
    }
    const type = String(payload.type ?? event ?? '');
    if (payload.id != null) {
      const key = `${type}:${payload.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    }

    const id = runKey(payload, type);
    const prev = runs[id];
    if (prev?.done && type !== 'error' && type !== 'stream_failed') return;
    const run = prev ? { ...prev } : newRun(id, now());
    if (!step(run, type, payload, now)) return;

    runs = { ...runs, [id]: run };
    const ids = Object.keys(runs);
    if (ids.length > maxRuns) {
      for (const old of ids.slice(0, ids.length - maxRuns)) delete runs[old];
    }
    onChange(runs, run);
  }

  return {
    apply,
    get runs() {
      return runs;
    },
    reset() {
      runs = {};
      seen.clear();
      chunks.clear();
      onChange(runs, null);
    },
  };
}

/** The run that started last, or null. */
export function latestRun(runs) {
  let latest = null;
  for (const id in runs) {
    const r = runs[id];
    if (!latest || r.startedAt >= latest.startedAt) latest = r;
  }
  return latest;
}

function newRun(id, at) {
  return {
    id,
    status: 'streaming',
    done: false,
    text: '',
    reasoning: '',
    parts: [],
    toolCalls: [],
    approvals: [],
    citations: [],
    provider: null,
    model: null,
    usage: null,
    reason: null,
    error: null,
    steps: 0,
    startedAt: at,
  };
}

// Applies one event to a run (a fresh copy). Returns false when nothing changed.
function step(run, type, p, now) {
  switch (type) {
    case 'stream_start':
      run.steps++;
      if (p.provider != null) run.provider = p.provider;
      if (p.model != null) run.model = p.model;
      return true;
    case 'text_delta':
    case 'reasoning_delta': {
      if (typeof p.delta !== 'string' || p.delta === '') return false;
      const kind = type === 'text_delta' ? 'text' : 'reasoning';
      // One text part per step (providers may rotate message ids mid-answer),
      // one reasoning part per reasoning id.
      const partId = kind === 'text' ? `text-${run.steps}` : `reasoning-${p.reasoning_id ?? run.steps}`;
      const parts = run.parts.slice();
      const at = parts.findIndex((part) => part.id === partId);
      if (at >= 0) parts[at] = { ...parts[at], text: parts[at].text + p.delta };
      else parts.push({ id: partId, type: kind, text: p.delta });
      run.parts = parts;
      run.text = joinParts(parts, 'text');
      run.reasoning = joinParts(parts, 'reasoning');
      return true;
    }
    case 'tool_call': {
      const call = {
        id: String(p.tool_id ?? p.id),
        name: p.tool_name ?? null,
        arguments: p.arguments ?? null,
        status: 'running',
        result: undefined,
        error: null,
      };
      const calls = run.toolCalls.filter((c) => c.id !== call.id);
      if (calls.length === run.toolCalls.length) run.parts = [...run.parts, { id: `tool-${call.id}`, type: 'tool', toolId: call.id }];
      run.toolCalls = [...calls, call];
      return true;
    }
    case 'tool_result': {
      const toolId = String(p.tool_id ?? p.id);
      const status = p.denied ? 'denied' : p.successful === false ? 'failed' : p.preliminary ? 'running' : 'done';
      const result = { status, result: p.result, error: p.error ?? null };
      const at = run.toolCalls.findIndex((c) => c.id === toolId);
      if (at >= 0) {
        run.toolCalls = run.toolCalls.map((c, i) => (i === at ? { ...c, ...result } : c));
      } else {
        run.toolCalls = [...run.toolCalls, { id: toolId, name: p.tool_name ?? null, arguments: null, ...result }];
        run.parts = [...run.parts, { id: `tool-${toolId}`, type: 'tool', toolId }];
      }
      return true;
    }
    case 'tool_approval_request':
      run.approvals = Array.isArray(p.approvals) ? p.approvals : [];
      run.status = 'awaiting_approval';
      return true;
    case 'citation':
      if (!p.citation) return false;
      run.citations = [...run.citations, p.citation];
      return true;
    case 'stream_end':
      run.done = true;
      run.reason = p.reason ?? null;
      run.usage = p.usage ?? null;
      if (run.status === 'streaming') run.status = 'done';
      run.endedAt = now();
      return true;
    case 'error':
    case 'stream_failed':
      run.error = String(p.message ?? 'The stream failed.');
      if (p.recoverable === true) return true;
      run.status = 'error';
      run.done = true;
      run.endedAt = now();
      return true;
    case 'text_start':
    case 'text_end':
    case 'reasoning_start':
    case 'reasoning_end':
      return false;
    default:
      // Provider error types (e.g. "rate_limited") arrive with a message.
      if (typeof p.message === 'string' && 'recoverable' in p) return step(run, 'error', p, now);
      return false;
  }
}

function joinParts(parts, type) {
  return parts
    .filter((part) => part.type === type && part.text.trim() !== '')
    .map((part) => part.text)
    .join('\n\n');
}
