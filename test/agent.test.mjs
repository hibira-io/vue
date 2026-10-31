import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_EVENTS, CHUNK_EVENT, createAgentStore, latestRun } from '../agent.js';

function store(options) {
  const changes = [];
  const s = createAgentStore((runs, changed) => changes.push([runs, changed]), options);
  return { s, changes };
}

// What hibira-io/laravel's HibiraBroadcaster sends for a payload too big for one event.
function chunked(event, payload, size = 50) {
  const json = JSON.stringify(payload);
  const parts = [];
  for (let i = 0; i < json.length; i += size) parts.push(json.slice(i, i + size));
  return parts.map((data, index) => ({ id: 'c1', event, index, count: parts.length, data }));
}

const inv = 'inv-1';
let n = 0;
const ev = (type, fields = {}) => ({ id: `e${++n}`, invocation_id: inv, type, timestamp: 1, ...fields });

test('a run put back together: text across steps, reasoning, tools, usage', () => {
  const { s, changes } = store();
  const events = [
    ev('stream_start', { provider: 'anthropic', model: 'claude' }),
    ev('reasoning_delta', { reasoning_id: 'r1', delta: 'Thinking' }),
    ev('text_delta', { message_id: 'm1', delta: 'Let me ' }),
    ev('text_delta', { message_id: 'm2', delta: 'check.' }),
    ev('tool_call', { tool_id: 't1', tool_name: 'weather', arguments: { city: 'Tokyo' } }),
    ev('tool_result', { tool_id: 't1', tool_name: 'weather', result: '18C', successful: true, error: null, denied: false }),
    ev('stream_start', { provider: 'anthropic', model: 'claude' }),
    ev('text_delta', { message_id: 'm3', delta: 'It is 18C.' }),
    ev('stream_end', { reason: 'stop', usage: { input_tokens: 10 } }),
  ];
  for (const e of events) s.apply(e, e.type);
  const run = s.runs[inv];
  assert.equal(run.text, 'Let me check.\n\nIt is 18C.');
  assert.equal(run.reasoning, 'Thinking');
  assert.equal(run.status, 'done');
  assert.equal(run.done, true);
  assert.equal(run.model, 'claude');
  assert.equal(run.steps, 2);
  assert.deepEqual(run.usage, { input_tokens: 10 });
  assert.deepEqual(run.toolCalls, [
    { id: 't1', name: 'weather', arguments: { city: 'Tokyo' }, status: 'done', result: '18C', error: null },
  ]);
  assert.deepEqual(run.parts.map((p) => p.type), ['reasoning', 'text', 'tool', 'text']);
  assert.notEqual(changes[0][1], changes[1][1], 'runs are replaced, not mutated');
  assert.equal(latestRun(s.runs), run);
});

test('replayed events are ignored, so rewind is safe', () => {
  const { s, changes } = store();
  const delta = ev('text_delta', { message_id: 'm', delta: 'Hi' });
  s.apply(delta, 'text_delta');
  s.apply(delta, 'text_delta');
  assert.equal(s.runs[inv].text, 'Hi');
  assert.equal(changes.length, 1);
});

test('chunked events are joined, in any order, once', () => {
  const { s } = store();
  const big = ev('tool_result', { tool_id: 't9', result: { rows: Array.from({ length: 40 }, (_, i) => `row "${i}" 東京 \\ /`) }, successful: true });
  const chunks = chunked('tool_result', big);
  assert.ok(chunks.length > 3);
  for (const c of [...chunks].reverse()) s.apply(c, CHUNK_EVENT);
  assert.deepEqual(s.runs[inv].toolCalls[0].result, big.result);
  for (const c of chunks) s.apply(c, CHUNK_EVENT);
  assert.equal(s.runs[inv].toolCalls.length, 1);
});

test('approvals pause the run; failures end it', () => {
  const { s } = store();
  s.apply(ev('tool_call', { tool_id: 't1', tool_name: 'refund' }), 'tool_call');
  s.apply(ev('tool_approval_request', { approvals: [{ id: 'a1', tool_name: 'refund' }] }), 'tool_approval_request');
  s.apply(ev('stream_end', { reason: 'stop' }), 'stream_end');
  assert.equal(s.runs[inv].status, 'awaiting_approval');
  assert.equal(s.runs[inv].done, true);
  assert.deepEqual(s.runs[inv].approvals, [{ id: 'a1', tool_name: 'refund' }]);

  const failed = { id: 'f1', invocation_id: 'inv-2', type: 'stream_failed', message: 'The stream failed.', recoverable: false };
  s.apply(failed, 'stream_failed');
  assert.equal(s.runs['inv-2'].status, 'error');
  assert.equal(s.runs['inv-2'].error, 'The stream failed.');
});

test('broadcasts without an invocation id start a new run at each stream_start', () => {
  const { s } = store();
  const plain = (type, fields) => ({ id: `p${++n}`, invocation_id: null, type, ...fields });
  s.apply(plain('stream_start'), 'stream_start');
  s.apply(plain('text_delta', { delta: 'one' }), 'text_delta');
  s.apply(plain('stream_end', { reason: 'stop' }), 'stream_end');
  s.apply(plain('stream_start'), 'stream_start');
  s.apply(plain('text_delta', { delta: 'two' }), 'text_delta');
  assert.deepEqual(Object.values(s.runs).map((r) => r.text), ['one', 'two']);
});

test('keeps maxRuns runs and listens to the chunk event', () => {
  const { s } = store({ maxRuns: 2 });
  for (const id of ['a', 'b', 'c']) s.apply({ id: `x${id}`, invocation_id: id, type: 'stream_start' }, 'stream_start');
  assert.deepEqual(Object.keys(s.runs), ['b', 'c']);
  assert.ok(AGENT_EVENTS.includes(CHUNK_EVENT));
});
