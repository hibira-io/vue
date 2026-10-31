// Vue composables for pusher-js on Hibira (and Laravel Echo, or any
// Pusher-compatible server): one connection for the app, channels shared
// between components, events, presence members, connection state, client
// events, and useStream() for LLM output sent with streamToChannel().
//
// Works with Vue 3 and Vue 2.7 (which has the Composition API built in), so
// it also backs @hibira-io/nuxt for Nuxt 3/4 and Nuxt 2.
//
// The connection opens the first time a component asks for it, and only in
// the browser: on the server usePusher() returns null and the composables
// keep their empty values, so server rendering never connects.

import { computed, getCurrentInstance, inject, isRef, onMounted, onScopeDispose, shallowRef, watch } from 'vue';
import Pusher from 'pusher-js';
import { acquireChannel, hibiraOptions, isClientEvent, presenceMembers, releaseChannel } from './client.js';
import { STREAM_EVENT, createStreamStore, followStream, latestStream } from './stream.js';
import { AGENT_EVENTS, createAgentStore, latestRun } from './agent.js';

export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore, followStream } from './stream.js';
export { AGENT_EVENTS, CHUNK_EVENT, createAgentStore } from './agent.js';

export const HIBIRA_KEY = Symbol.for('hibira');

// The last plugin installed, for Vue 2 (which has no app-level provide) and
// for composables used outside a component tree.
let fallback = null;

/**
 * Creates the plugin: `app.use(createHibira({ appKey, options }))` in Vue 3,
 * `Vue.use(createHibira(...))` in Vue 2.7.
 *
 * @param {object} config
 * @param {string} [config.appKey] the app key from the Hibira portal
 * @param {object} [config.options] pusher-js options, merged over HIBIRA_DEFAULTS
 * @param {object|(() => object)} [config.client] an existing pusher-js client
 *   (or a function returning one) to use instead, e.g. `echo.connector.pusher`
 */
export function createHibira({ appKey, options, client } = {}) {
  let pusher = null;
  const hibira = {
    /** The pusher-js client; opened on first use in the browser, null on the server. */
    get client() {
      if (pusher) return pusher;
      if (typeof window === 'undefined') return null;
      if (client) pusher = typeof client === 'function' ? client() : client;
      else if (appKey) pusher = new Pusher(appKey, hibiraOptions(options));
      return pusher;
    },
    /** Disconnects a client this plugin opened. */
    disconnect() {
      if (pusher && !client) pusher.disconnect();
      pusher = null;
    },
    install(app) {
      fallback = hibira;
      if (app.config?.globalProperties) {
        app.provide(HIBIRA_KEY, hibira);
        app.config.globalProperties.$hibira = hibira;
      } else {
        app.prototype.$hibira = hibira; // Vue 2: app is the Vue constructor
      }
    },
  };
  return hibira;
}

/** The plugin instance (provided, or else the last one installed). */
export function useHibira() {
  const provided = getCurrentInstance() ? inject(HIBIRA_KEY, null) : null;
  return provided ?? fallback;
}

/** The pusher-js client, or null on the server or without a plugin. */
export function usePusher() {
  return useHibira()?.client ?? null;
}

// Plain value, ref or getter.
function read(source) {
  if (typeof source === 'function') return source();
  return isRef(source) ? source.value : source;
}

// A channel name subscribes; a channel object (Echo's .subscription, a
// channel from useChannel) is used as is.
function isChannel(value) {
  return value != null && typeof value === 'object' && typeof value.bind === 'function';
}

/**
 * Subscribes to a channel while the component (or effect scope) lives.
 * Components that use the same name share one subscription.
 * @param {string|null|import('vue').Ref|(() => string|null)} name
 * @returns {import('vue').ShallowRef} the pusher-js channel, or null
 */
export function useChannel(name) {
  const pusher = usePusher();
  const channel = shallowRef(null);
  let current = null;

  const leave = () => {
    if (current) releaseChannel(pusher, current);
    current = null;
    channel.value = null;
  };
  const stop = watch(
    () => read(name),
    (next) => {
      if (next === current) return;
      leave();
      if (!pusher || !next) return;
      current = next;
      channel.value = acquireChannel(pusher, next);
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    leave();
  });
  return channel;
}

// A ref holding the channel for a name, a channel, or a ref/getter of either.
function useTarget(target) {
  const named = useChannel(() => {
    const t = read(target);
    return isChannel(t) ? null : t;
  });
  return computed(() => {
    const t = read(target);
    return isChannel(t) ? t : named.value;
  });
}

/**
 * Calls handler(data, metadata) for each `event` on a channel.
 * @param target channel name, channel, or a ref/getter of either
 * @param {string|import('vue').Ref|(() => string)} event
 * @returns the channel ref
 */
export function useEvent(target, event, handler) {
  const channel = useTarget(target);
  const fn = (data, metadata) => handler(data, metadata);
  let bound = null;

  const unbind = () => {
    if (bound) bound[0].unbind(bound[1], fn);
    bound = null;
  };
  const stop = watch(
    () => [channel.value, read(event)],
    ([ch, ev]) => {
      unbind();
      if (!ch || !ev) return;
      ch.bind(ev, fn);
      bound = [ch, ev];
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    unbind();
  });
  return channel;
}

/**
 * The connection state as a ref: "initialized", "connecting", "connected",
 * "unavailable", "failed" or "disconnected".
 */
export function useConnectionState() {
  const pusher = usePusher();
  // Starts as "initialized", what the server rendered, and catches up once
  // mounted so hydration matches.
  const state = shallowRef('initialized');
  if (pusher) {
    const fn = ({ current }) => {
      state.value = current;
    };
    const sync = () => {
      state.value = pusher.connection.state;
    };
    pusher.connection.bind('state_change', fn);
    if (getCurrentInstance()) onMounted(sync);
    else sync();
    onScopeDispose(() => pusher.connection.unbind('state_change', fn));
  }
  return state;
}

const PRESENCE_EVENTS = ['pusher:subscription_succeeded', 'pusher:member_added', 'pusher:member_removed'];

/**
 * Members of a presence channel, kept up to date.
 * @returns {{channel, members, others, me, count}} refs; members are
 *   [{ id, info, me }] with you first; info is the user_info your auth signed
 */
export function usePresence(target) {
  const channel = useTarget(target);
  const members = shallowRef([]);
  const update = () => {
    members.value = presenceMembers(channel.value);
  };
  let bound = null;

  const unbind = () => {
    if (bound) for (const ev of PRESENCE_EVENTS) bound.unbind(ev, update);
    bound = null;
  };
  const stop = watch(
    channel,
    (ch) => {
      unbind();
      update();
      if (!ch) return;
      for (const ev of PRESENCE_EVENTS) ch.bind(ev, update);
      bound = ch;
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    unbind();
  });

  return {
    channel,
    members,
    others: computed(() => members.value.filter((m) => !m.me)),
    me: computed(() => members.value.find((m) => m.me) ?? null),
    count: computed(() => members.value.length),
  };
}

/**
 * A function that sends a client event on a private or presence channel:
 * `trigger('client-typing', { at: Date.now() })`. Returns false when the
 * channel is not subscribed yet. Turn on client events for the app first.
 */
export function useTrigger(target) {
  const channel = useTarget(target);
  return (event, data) => {
    if (!isClientEvent(event)) throw new Error(`useTrigger: "${event}" must start with "client-"`);
    const ch = channel.value;
    if (!ch || !ch.subscribed) return false;
    return ch.trigger(event, data ?? {});
  };
}

/**
 * Text streamed to a channel with streamToChannel(), put back together.
 *
 * @param target channel name, channel, or a ref/getter of either
 * @param {object} [options]
 * @param {string} [options.event="ai-stream"] event name
 * @param {string|import('vue').Ref|(() => string)} [options.id] follow only this stream id
 * @param {number} [options.maxStreams=50] streams kept, oldest dropped first
 * @param {boolean|object} [options.rewind] catch up from channel history on
 *   each subscription: true, or { seconds = 300, limit, timeout = 5000 }
 * @returns {{stream, streams, text, done, error, history, reset, channel}} refs;
 *   `stream` is the one with `id`, or else the one that started last
 */
export function useStream(target, { event = STREAM_EVENT, id, maxStreams = 50, rewind } = {}) {
  const pusher = usePusher();
  const channel = useTarget(target);
  const streams = shallowRef({});
  const history = shallowRef(null);
  const store = createStreamStore(
    (next) => {
      streams.value = next;
    },
    { maxStreams },
  );
  let stopFollowing = null;
  const unfollow = () => {
    stopFollowing?.();
    stopFollowing = null;
  };
  const stop = watch(
    () => [channel.value, read(event)],
    ([ch, ev]) => {
      unfollow();
      if (!ch || !ev) return;
      stopFollowing = followStream(ch, {
        event: ev,
        client: ch.pusher ?? pusher,
        rewind,
        onHistory: (result) => {
          history.value = result;
        },
        apply: (payload) => {
          const want = read(id);
          if (want != null && String(payload?.id) !== String(want)) return;
          store.apply(payload);
        },
      });
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    unfollow();
  });
  const stream = computed(() => {
    const want = read(id);
    return want != null ? streams.value[String(want)] ?? null : latestStream(streams.value);
  });

  return {
    channel,
    stream,
    streams,
    text: computed(() => stream.value?.text ?? ''),
    done: computed(() => stream.value?.done ?? false),
    error: computed(() => stream.value?.error ?? null),
    history,
    reset: store.reset,
  };
}

/**
 * A Laravel AI SDK agent's stream (laravel/ai broadcastOnQueue(), broadcast()
 * or broadcastNow()), put back together: text, reasoning, tool calls and
 * approvals. Events hibira-io/laravel split into chunks are joined.
 *
 * @param target channel name, channel, or a ref/getter of either, e.g.
 *   `private-hibira-ai.user.${user.id}` (AgentChannel::user() in Laravel)
 * @param {object} [options]
 * @param {string|import('vue').Ref|(() => string)} [options.invocationId] follow only this run
 * @param {number} [options.maxRuns=20] runs kept, oldest dropped first
 * @param {boolean|object} [options.rewind] catch up from channel history on
 *   each subscription: true, or { seconds = 300, limit, timeout = 5000 }
 * @param {string[]} [options.events] extra event names to listen to
 * @returns {{run, runs, text, reasoning, status, done, error, toolCalls, approvals, history, reset, channel}} refs;
 *   `run` is the one with `invocationId`, or else the one that started last
 */
export function useAgentStream(target, { invocationId, maxRuns = 20, rewind, events } = {}) {
  const pusher = usePusher();
  const channel = useTarget(target);
  const runs = shallowRef({});
  const history = shallowRef(null);
  const store = createAgentStore(
    (next) => {
      runs.value = next;
    },
    { maxRuns },
  );
  let stopFollowing = null;
  const unfollow = () => {
    stopFollowing?.();
    stopFollowing = null;
  };
  const stop = watch(
    channel,
    (ch) => {
      unfollow();
      if (!ch) return;
      stopFollowing = followStream(ch, {
        event: events?.length ? [...AGENT_EVENTS, ...events] : AGENT_EVENTS,
        client: ch.pusher ?? pusher,
        rewind,
        onHistory: (result) => {
          history.value = result;
        },
        apply: (payload, name) => store.apply(payload, name),
      });
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    unfollow();
  });
  const run = computed(() => {
    const want = read(invocationId);
    return want != null ? runs.value[String(want)] ?? null : latestRun(runs.value);
  });

  return {
    channel,
    run,
    runs,
    text: computed(() => run.value?.text ?? ''),
    reasoning: computed(() => run.value?.reasoning ?? ''),
    status: computed(() => run.value?.status ?? 'idle'),
    done: computed(() => run.value?.done ?? false),
    error: computed(() => run.value?.error ?? null),
    toolCalls: computed(() => run.value?.toolCalls ?? []),
    approvals: computed(() => run.value?.approvals ?? []),
    history,
    reset: store.reset,
  };
}
