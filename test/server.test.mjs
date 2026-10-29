import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamToChannel, textOf } from '../server.js';
import { createStreamStore } from '../stream.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recorder({ delay = 0, fail } = {}) {
  const sent = [];
  return {
    sent,
    async trigger(channel, event, data, params) {
      if (fail && fail(data)) throw new Error('HTTP 413');
      await sleep(delay * Math.random());
      sent.push({ channel, event, data: JSON.parse(JSON.stringify(data)), params });
    },
  };
}

async function* tokens(list, gap = 0) {
  for (const t of list) {
    if (gap) await sleep(gap);
    yield t;
  }
}

test('tokens are batched, in order, and end with the whole text', async () => {
  const p = recorder({ delay: 5 });
  const words = Array.from({ length: 60 }, (_, i) => `w${i} `);
  const res = await streamToChannel(p, 'private-chat', tokens(words, 2), { id: 's1', interval: 30, meta: { model: 'x' } });
  const text = words.join('');
  assert.equal(res.text, text);
  assert.equal(res.id, 's1');
  assert.ok(p.sent.length < 20, `batched into ${p.sent.length} events`);
  assert.equal(res.events, p.sent.length);
  p.sent.forEach((e, i) => {
    assert.equal(e.data.seq, i);
    assert.equal(e.channel, 'private-chat');
    assert.equal(e.event, 'ai-stream');
  });
  assert.deepEqual(p.sent[0].data.meta, { model: 'x' });
  assert.equal(p.sent[1].data.meta, undefined);
  const last = p.sent.at(-1).data;
  assert.equal(last.done, true);
  assert.equal(last.text, text);

  const store = createStreamStore(() => {});
  for (const e of p.sent) store.apply(e.data);
  assert.equal(store.streams.s1.text, text);
  assert.equal(store.streams.s1.done, true);
});

test('events stay under maxBytes and never cut a character', async () => {
  const p = recorder();
  const big = '漢字テキスト🙂"\n'.repeat(400);
  await streamToChannel(p, 'c', [big], { id: 'x', maxBytes: 1000 });
  for (const e of p.sent) assert.ok(Buffer.byteLength(JSON.stringify(e.data)) <= 1000, JSON.stringify(e.data).length);
  const joined = p.sent.filter((e) => e.data.delta).map((e) => e.data.delta).join('');
  assert.equal(joined, big);
  const last = p.sent.at(-1).data;
  assert.equal(last.done, true);
  assert.equal(last.text, undefined, 'whole text left out when too big');
});

test('SDK chunk shapes', async () => {
  const anthropic = [
    { type: 'message_start', message: {} },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
  ];
  const openai = [{ choices: [{ delta: { role: 'assistant' } }] }, { choices: [{ delta: { content: 'Hi' } }] }, { choices: [] }];
  const responses = [{ type: 'response.output_text.delta', delta: 'Hi' }, { type: 'response.completed' }];
  const vercel = [{ type: 'text-delta', text: 'Hi' }, { type: 'text-delta', textDelta: '!' }];
  const gemini = [{ text: 'Hi' }];
  assert.equal((await streamToChannel(recorder(), 'c', anthropic)).text, 'Hi there');
  assert.equal((await streamToChannel(recorder(), 'c', openai)).text, 'Hi');
  assert.equal((await streamToChannel(recorder(), 'c', responses)).text, 'Hi');
  assert.equal((await streamToChannel(recorder(), 'c', vercel)).text, 'Hi!');
  assert.equal((await streamToChannel(recorder(), 'c', gemini)).text, 'Hi');
  assert.equal(textOf(42), '');
  const custom = await streamToChannel(recorder(), 'c', [{ t: 'a' }, { t: 'b' }], { pick: (c) => c.t });
  assert.equal(custom.text, 'ab');
});

test('ReadableStream of bytes, split inside a character', async () => {
  const bytes = new TextEncoder().encode('héllo 🙂');
  const rs = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const p = recorder();
  const res = await streamToChannel(p, 'c', rs);
  assert.equal(res.text, 'héllo 🙂');
});

test('socketId, custom event, and a source that fails', async () => {
  const p = recorder();
  async function* failing() {
    yield 'partial ';
    throw new Error('overloaded');
  }
  await assert.rejects(streamToChannel(p, 'c', failing(), { id: 'f', event: 'answer', socketId: '1.2' }), /overloaded/);
  const last = p.sent.at(-1);
  assert.equal(last.event, 'answer');
  assert.deepEqual(last.params, { socket_id: '1.2' });
  assert.equal(last.data.done, true);
  assert.equal(last.data.error, 'overloaded');
  assert.equal(last.data.text, 'partial ');
});

test('abort and a failing trigger', async () => {
  const ac = new AbortController();
  const p = recorder();
  const run = streamToChannel(p, 'c', tokens(['a', 'b', 'c', 'd', 'e'], 20), { signal: ac.signal, interval: 5 });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(run);
  assert.equal(p.sent.at(-1).data.error, 'aborted');

  const broken = recorder({ fail: (d) => d.seq === 0 });
  await assert.rejects(streamToChannel(broken, 'c', tokens(['a', 'b'], 30), { interval: 5 }), /HTTP 413/);

  await assert.rejects(streamToChannel(recorder(), 'c', 42), /source must be/);
  await assert.rejects(streamToChannel(recorder(), 'c', ['a'], { maxBytes: 40, meta: { big: 'x'.repeat(50) } }), /too small/);
});

test('empty source still sends one done event', async () => {
  const p = recorder();
  const res = await streamToChannel(p, 'c', [], { id: 'e', meta: { m: 1 } });
  assert.equal(res.events, 1);
  assert.deepEqual(p.sent[0].data, { id: 'e', seq: 0, done: true, meta: { m: 1 }, text: '' });
});
