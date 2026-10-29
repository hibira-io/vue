// Helpers shared by the React hooks and Vue composables. Kept identical in
// @hibira-io/react and @hibira-io/vue.

/** pusher-js options for Hibira; yours are merged over them. */
export const HIBIRA_DEFAULTS = {
  cluster: 'hkg', // required by pusher-js, unused once wsHost is set
  wsHost: 'ws.hibira.io',
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
};

export function hibiraOptions(options = {}) {
  return { ...HIBIRA_DEFAULTS, ...options };
}

// pusher.unsubscribe(name) drops the channel for every component that uses
// it, so subscriptions are counted per client and the channel is left only
// when the last user lets go.
const counts = new WeakMap();

export function acquireChannel(pusher, name) {
  let byName = counts.get(pusher);
  if (!byName) counts.set(pusher, (byName = new Map()));
  const n = (byName.get(name) ?? 0) + 1;
  byName.set(name, n);
  return (n > 1 && pusher.channel(name)) || pusher.subscribe(name);
}

export function releaseChannel(pusher, name) {
  const byName = counts.get(pusher);
  const n = (byName?.get(name) ?? 1) - 1;
  if (n > 0) {
    byName.set(name, n);
    return;
  }
  byName?.delete(name);
  pusher.unsubscribe(name);
}

/** [{ id, info, me }] of a pusher-js presence channel, you first. */
export function presenceMembers(channel) {
  const m = channel?.members;
  if (!m || !channel.subscribed) return [];
  const list = [];
  m.each((member) => list.push({ id: String(member.id), info: member.info ?? null, me: String(member.id) === String(m.myID) }));
  return list.sort((a, b) => (a.me === b.me ? 0 : a.me ? -1 : 1));
}

export function isClientEvent(event) {
  return typeof event === 'string' && event.startsWith('client-');
}
