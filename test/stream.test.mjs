import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamStore, followStream, latestStream } from '../stream.js';

function store() {
  const changes = [];
  const s = createStreamStore((streams, changed) => changes.push([streams, changed]));
  return { s, changes };
}

test('chunks put back together in order, with meta and the final text', () => {
  const { s, changes } = store();
  s.apply({ id: 'a', seq: 0, delta: 'Hel', meta: { model: 'm' } });
  s.apply({ id: 'a', seq: 1, delta: 'lo' });
  assert.equal(s.streams.a.text, 'Hello');
  assert.equal(s.streams.a.done, false);
  assert.deepEqual(s.streams.a.meta, { model: 'm' });
  s.apply({ id: 'a', seq: 2, done: true, text: 'Hello' });
  assert.equal(s.streams.a.done, true);
  assert.equal(s.streams.a.incomplete, false);
  assert.equal(changes.length, 3);
  // Each change is a new object, so React and Vue see it.
  assert.notEqual(changes[0][0], changes[1][0]);
  assert.notEqual(changes[0][1], changes[1][1]);
});

test('an early chunk waits for the gap, duplicates are ignored', () => {
  const { s } = store();
  s.apply({ id: 'a', seq: 0, delta: 'a' });
  s.apply({ id: 'a', seq: 2, delta: 'c' });
  assert.equal(s.streams.a.text, 'a');
  s.apply({ id: 'a', seq: 1, delta: 'b' });
  assert.equal(s.streams.a.text, 'abc');
  s.apply({ id: 'a', seq: 1, delta: 'b' });
  assert.equal(s.streams.a.text, 'abc');
  s.apply({ id: 'a', seq: 3, done: true });
  s.apply({ id: 'a', seq: 3, done: true });
  assert.equal(s.streams.a.done, true);
  assert.equal(s.streams.a.text, 'abc');
});

test('joining late: the final text fixes it, or the stream is marked incomplete', () => {
  const { s } = store();
  s.apply({ id: 'a', seq: 4, delta: 'end' });
  assert.equal(s.streams.a.text, 'end');
  s.apply({ id: 'a', seq: 5, done: true, text: 'the whole end' });
  assert.equal(s.streams.a.text, 'the whole end');
  assert.equal(s.streams.a.incomplete, false);

  s.apply({ id: 'b', seq: 3, delta: 'x' });
  s.apply({ id: 'b', seq: 4, done: true });
  assert.equal(s.streams.b.incomplete, true);
  assert.equal(s.streams.b.done, true);
});

test('a final text behind a gap that never fills still ends the stream', () => {
  const { s } = store();
  s.apply({ id: 'a', seq: 0, delta: 'a' });
  s.apply({ id: 'a', seq: 3, done: true, text: 'abcd' });
  assert.equal(s.streams.a.done, true);
  assert.equal(s.streams.a.text, 'abcd');
  s.apply({ id: 'a', seq: 1, delta: 'b' });
  assert.equal(s.streams.a.text, 'abcd');
});

test('errors, latest stream, maxStreams and reset', () => {
  const changes = [];
  const s = createStreamStore((st) => changes.push(st), { maxStreams: 2 });
  s.apply({ id: 'a', seq: 0, delta: 'x' });
  s.apply({ id: 'a', seq: 1, done: true, error: 'overloaded' });
  assert.equal(s.streams.a.error, 'overloaded');
  s.apply({ id: 'b', seq: 0, delta: 'y' });
  s.apply({ id: 'c', seq: 0, delta: 'z' });
  assert.deepEqual(Object.keys(s.streams), ['b', 'c']);
  assert.equal(latestStream(s.streams).id, 'c');
  s.apply(null);
  s.apply({ seq: 0 });
  s.reset();
  assert.deepEqual(s.streams, {});
  assert.equal(latestStream(s.streams), null);
});

function fakeChannel(subscribed = false) {
  const handlers = new Map();
  const sent = [];
  return {
    name: 'private-chat',
    subscribed,
    sent,
    pusher: { send_event: (ev, data, ch) => sent.push([ev, data, ch]) },
    bind(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
    },
    unbind(ev, fn) {
      handlers.get(ev)?.delete(fn);
    },
    emit(ev, data) {
      for (const fn of [...(handlers.get(ev) ?? [])]) fn(data, {});
    },
    count() {
      let n = 0;
      for (const set of handlers.values()) n += set.size;
      return n;
    },
  };
}

test('followStream without rewind just applies events', () => {
  const ch = fakeChannel(true);
  const { s } = store();
  const stop = followStream(ch, { apply: s.apply });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'hi' });
  assert.equal(s.streams.a.text, 'hi');
  assert.equal(ch.sent.length, 0);
  stop();
  assert.equal(ch.count(), 0);
});

test('a reload rebuilds a stream that started before the page subscribed', () => {
  const ch = fakeChannel(false);
  const { s } = store();
  const results = [];
  const stop = followStream(ch, { apply: s.apply, rewind: true, onHistory: (r) => results.push(r) });
  ch.subscribed = true;
  ch.emit('pusher:subscription_succeeded', {});
  assert.deepEqual(ch.sent, [['pusher:rewind', { channel: 'private-chat', seconds: 300 }, 'private-chat']]);
  // Live chunks overtake the replay; both are held until the answer.
  ch.emit('ai-stream', { id: 'a', seq: 2, delta: 'c' });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'a', meta: { m: 1 } });
  ch.emit('ai-stream', { id: 'a', seq: 1, delta: 'b' });
  assert.equal(s.streams.a, undefined);
  ch.emit('pusher:rewind_succeeded', { count: 2, window: 3600, complete: true });
  assert.equal(s.streams.a.text, 'abc');
  assert.equal(s.streams.a.incomplete, false);
  assert.deepEqual(results, [{ count: 2, window: 3600, complete: true }]);
  ch.emit('ai-stream', { id: 'a', seq: 3, done: true });
  assert.equal(s.streams.a.done, true);
  assert.equal(s.streams.a.incomplete, false);
  stop();
  assert.equal(ch.count(), 0);
});

test('after a reconnect it asks for the time since the last event and fills the gap', () => {
  const ch = fakeChannel(true);
  const { s } = store();
  let t = 1_000_000;
  const stop = followStream(ch, { apply: s.apply, rewind: { seconds: 60, limit: 500 }, now: () => t });
  assert.deepEqual(ch.sent[0][1], { channel: 'private-chat', seconds: 60, limit: 500 });
  ch.emit('pusher:rewind_succeeded', { count: 0, window: 3600, complete: true });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'a' });
  t += 9_500;
  ch.emit('pusher:subscription_succeeded', {});
  assert.deepEqual(ch.sent[1][1], { channel: 'private-chat', seconds: 10 + 2, limit: 500 });
  ch.emit('ai-stream', { id: 'a', seq: 3, delta: 'd' });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'a' }); // slack brings this back
  ch.emit('ai-stream', { id: 'a', seq: 1, delta: 'b' });
  ch.emit('ai-stream', { id: 'a', seq: 2, delta: 'c' });
  ch.emit('pusher:rewind_succeeded', { count: 3, window: 3600, complete: true });
  assert.equal(s.streams.a.text, 'abcd');
  stop();
});

test('history off or not in the plan: held events still apply, and the error is reported', () => {
  const ch = fakeChannel(true);
  const { s } = store();
  const results = [];
  followStream(ch, { apply: s.apply, rewind: true, onHistory: (r) => results.push(r) });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'x' });
  ch.emit('pusher:rewind_error', { type: 'HistoryUnavailable', error: 'Channel history is not included in this app\'s plan', status: 403 });
  assert.equal(s.streams.a.text, 'x');
  assert.deepEqual(results, [{ error: "Channel history is not included in this app's plan" }]);
});

test('no answer: held events apply after the timeout', async () => {
  const ch = fakeChannel(true);
  const { s } = store();
  const results = [];
  followStream(ch, { apply: s.apply, rewind: { timeout: 20 }, onHistory: (r) => results.push(r) });
  ch.emit('ai-stream', { id: 'a', seq: 0, delta: 'x' });
  assert.equal(s.streams.a, undefined);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.streams.a.text, 'x');
  assert.equal(results.length, 1);
  assert.ok(results[0].error);
});

test('followStream with several event names passes the name and keeps arrival order without seq', () => {
  const ch = fakeChannel(true);
  const got = [];
  followStream(ch, { apply: (p, name) => got.push([name, p.id]), event: ['text_delta', 'tool_call'], rewind: true });
  ch.emit('tool_call', { id: 'b' });
  ch.emit('text_delta', { id: 'a' });
  ch.emit('text_delta', { id: 'c' });
  ch.emit('other', { id: 'x' });
  assert.deepEqual(got, []);
  ch.emit('pusher:rewind_succeeded', { count: 0, window: 60, complete: true });
  assert.deepEqual(got, [['tool_call', 'b'], ['text_delta', 'a'], ['text_delta', 'c']]);
  ch.emit('tool_call', { id: 'd' });
  assert.deepEqual(got.at(-1), ['tool_call', 'd']);
});
