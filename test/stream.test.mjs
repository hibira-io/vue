import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamStore, latestStream } from '../stream.js';

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
