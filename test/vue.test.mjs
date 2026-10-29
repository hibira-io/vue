// Runs against whichever Vue is installed: 3 by default, 2.7 in CI's vue-2
// job (npm install --no-save vue@2.7).
import './dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as VueNS from 'vue';
import {
  createHibira,
  useChannel,
  useConnectionState,
  useEvent,
  useHibira,
  usePresence,
  usePusher,
  useStream,
  useTrigger,
} from '../index.js';
import { fakePusher } from './fake-pusher.mjs';

const Vue = VueNS.default ?? VueNS;
const { effectScope, nextTick, ref } = VueNS;
const vue2 = String(Vue.version).startsWith('2.');

// Installs a plugin around a fake client and runs `fn` in an effect scope.
function setup(fn, pusher = fakePusher()) {
  const hibira = createHibira({ client: pusher });
  if (vue2) Vue.use(hibira);
  else VueNS.createApp({}).use(hibira);
  const scope = effectScope();
  const out = scope.run(fn);
  return { out, pusher, hibira, stop: () => scope.stop() };
}

// Mounts a component whose setup() runs `fn`; returns its result and unmount.
function mount(fn, hibira) {
  const el = document.createElement('div');
  const box = {};
  if (vue2) {
    if (hibira) Vue.use(hibira);
    const vm = new Vue({ setup: () => ((box.out = fn()), {}), render: (h) => h('div') }).$mount(el);
    return { box, unmount: () => vm.$destroy() };
  }
  const app = VueNS.createApp({ setup: () => ((box.out = fn()), () => null) });
  if (hibira) app.use(hibira);
  app.mount(el);
  return { box, unmount: () => app.unmount() };
}

test(`[vue ${Vue.version}] useChannel shares one subscription and leaves with the last user`, async () => {
  const pusher = fakePusher();
  const a = setup(() => useChannel('private-a'), pusher);
  const b = setup(() => useChannel('private-a'), pusher);
  assert.equal(a.out.value, pusher.channel('private-a'));
  assert.equal(a.out.value, b.out.value);
  assert.equal(pusher.log.filter(([op]) => op === 'subscribe').length, 1);
  a.stop();
  assert.ok(pusher.channel('private-a'));
  b.stop();
  assert.equal(pusher.channel('private-a'), undefined);
});

test(`[vue ${Vue.version}] useChannel follows a ref and a getter`, async () => {
  const name = ref('x');
  const { out, pusher, stop } = setup(() => useChannel(name));
  assert.equal(out.value.name, 'x');
  name.value = 'y';
  await nextTick();
  assert.equal(out.value.name, 'y');
  assert.equal(pusher.channel('x'), undefined);
  name.value = null;
  await nextTick();
  assert.equal(out.value, null);
  assert.equal(pusher.channels.size, 0);
  stop();

  const id = ref(1);
  const g = setup(() => useChannel(() => `private-order-${id.value}`));
  assert.equal(g.out.value.name, 'private-order-1');
  id.value = 2;
  await nextTick();
  assert.equal(g.out.value.name, 'private-order-2');
  g.stop();
});

test(`[vue ${Vue.version}] useEvent binds once, follows the event name, unbinds on stop`, async () => {
  const got = [];
  const event = ref('created');
  const { pusher, stop } = setup(() => useEvent('orders', event, (d, m) => got.push([d, m])));
  const ch = pusher.channel('orders');
  ch.emit('created', { id: 1 }, { user_id: 'u' });
  event.value = 'updated';
  await nextTick();
  ch.emit('created', { id: 2 });
  ch.emit('updated', { id: 3 });
  assert.deepEqual(got, [
    [{ id: 1 }, { user_id: 'u' }],
    [{ id: 3 }, undefined],
  ]);
  stop();
  assert.equal(ch.count('updated'), 0);
});

test(`[vue ${Vue.version}] useEvent takes a channel object (Echo subscription)`, async () => {
  const pusher = fakePusher();
  const ch = pusher.subscribe('private-echo');
  const got = [];
  const { stop } = setup(() => useEvent(ch, 'ping', (d) => got.push(d)), pusher);
  ch.emit('ping', 1);
  stop();
  ch.emit('ping', 2);
  assert.deepEqual(got, [1]);
  assert.ok(pusher.channel('private-echo'), 'not unsubscribed');
});

test(`[vue ${Vue.version}] useConnectionState`, async () => {
  const { out, pusher, stop } = setup(useConnectionState);
  assert.equal(out.value, 'connecting');
  pusher.setState('connected');
  assert.equal(out.value, 'connected');
  stop();
  pusher.setState('unavailable');
  assert.equal(out.value, 'connected', 'unbound after stop');
});

test(`[vue ${Vue.version}] usePresence`, async () => {
  const { out, pusher } = setup(() => usePresence('presence-room'));
  assert.deepEqual(out.members.value, []);
  pusher.succeed('presence-room', { a: { name: 'A' }, b: { name: 'B' } }, 'b');
  assert.deepEqual(out.members.value, [
    { id: 'b', info: { name: 'B' }, me: true },
    { id: 'a', info: { name: 'A' }, me: false },
  ]);
  assert.equal(out.me.value.id, 'b');
  pusher.join('presence-room', 'c', { name: 'C' });
  assert.deepEqual(out.others.value.map((m) => m.id), ['a', 'c']);
  pusher.leave('presence-room', 'a');
  assert.equal(out.count.value, 2);
});

test(`[vue ${Vue.version}] useTrigger`, async () => {
  const { out, pusher } = setup(() => useTrigger('private-chat'));
  assert.equal(out('client-typing', { a: 1 }), false);
  pusher.succeed('private-chat');
  assert.equal(out('client-typing', { a: 1 }), true);
  assert.deepEqual(pusher.channel('private-chat').sent, [['client-typing', { a: 1 }]]);
  assert.throws(() => out('typing'), /must start with "client-"/);
});

test(`[vue ${Vue.version}] useStream`, async () => {
  const { out, pusher } = setup(() => useStream('private-ai'));
  const ch = pusher.channel('private-ai');
  assert.equal(out.text.value, '');
  ch.emit('ai-stream', { id: 's1', seq: 0, delta: 'Hel', meta: { model: 'm' } });
  ch.emit('ai-stream', { id: 's1', seq: 1, delta: 'lo' });
  assert.equal(out.text.value, 'Hello');
  assert.equal(out.done.value, false);
  assert.deepEqual(out.stream.value.meta, { model: 'm' });
  ch.emit('ai-stream', { id: 's1', seq: 2, done: true, error: 'overloaded' });
  assert.equal(out.done.value, true);
  assert.equal(out.error.value, 'overloaded');
  ch.emit('ai-stream', { id: 's2', seq: 0, delta: 'Next' });
  assert.equal(out.text.value, 'Next');
  out.reset();
  assert.equal(out.stream.value, null);
});

test(`[vue ${Vue.version}] useStream with an id ref and a custom event`, async () => {
  const id = ref('mine');
  const { out, pusher } = setup(() => useStream('private-ai', { id, event: 'answer' }));
  const ch = pusher.channel('private-ai');
  ch.emit('answer', { id: 'other', seq: 0, delta: 'no' });
  ch.emit('ai-stream', { id: 'mine', seq: 0, delta: 'no' });
  ch.emit('answer', { id: 'mine', seq: 0, delta: 'yes' });
  assert.equal(out.text.value, 'yes');
  id.value = 'other';
  assert.equal(out.stream.value, null);
});

test(`[vue ${Vue.version}] in a component: plugin provided, state synced on mount, cleanup on unmount`, async () => {
  const pusher = fakePusher();
  const hibira = createHibira({ client: () => pusher });
  const { box, unmount } = mount(
    () => ({ hibira: useHibira(), pusher: usePusher(), state: useConnectionState(), channel: useChannel('c') }),
    hibira,
  );
  assert.equal(box.out.hibira, hibira);
  assert.equal(box.out.pusher, pusher);
  assert.equal(box.out.state.value, 'connecting');
  assert.ok(pusher.channel('c'));
  unmount();
  assert.equal(pusher.channel('c'), undefined);
  hibira.disconnect();
  assert.ok(!pusher.log.some(([op]) => op === 'disconnect'), 'a passed-in client is not disconnected');
});

test(`[vue ${Vue.version}] createHibira opens pusher-js lazily with Hibira defaults`, async () => {
  const hibira = createHibira({ appKey: 'key', options: { wsHost: '127.0.0.1', wsPort: 9, forceTLS: false, enabledTransports: ['ws'] } });
  const saved = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(hibira.client, null, 'no connection on the server');
  } finally {
    globalThis.window = saved;
  }
  const pusher = hibira.client;
  assert.equal(pusher.key, 'key');
  assert.equal(pusher.config.cluster, 'hkg');
  assert.equal(pusher.config.wsHost, '127.0.0.1');
  assert.equal(hibira.client, pusher, 'one client');
  hibira.disconnect();
  assert.equal(pusher.connection.state, 'disconnected');
});
