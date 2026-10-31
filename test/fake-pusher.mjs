// A stand-in for a pusher-js client: subscribe/unsubscribe/channel, a
// connection with state_change, and channels whose events tests emit by hand
// with pusher-js's (data, metadata) arguments.
function emitter() {
  const handlers = new Map();
  return {
    handlers,
    bind(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
    },
    unbind(ev, fn) {
      if (fn) handlers.get(ev)?.delete(fn);
      else handlers.delete(ev);
    },
    emit(ev, data, meta) {
      for (const fn of [...(handlers.get(ev) ?? [])]) fn(data, meta);
    },
    count(ev) {
      return handlers.get(ev)?.size ?? 0;
    },
  };
}

function members() {
  const map = new Map();
  return {
    myID: null,
    me: null,
    count: 0,
    map,
    each(fn) {
      for (const [id, info] of map) fn({ id, info });
    },
  };
}

export function fakePusher() {
  const channels = new Map();
  const log = [];
  const connection = { state: 'connecting', ...emitter() };
  const pusher = {
    log,
    connection,
    channels,
    subscribe(name) {
      log.push(['subscribe', name]);
      let ch = channels.get(name);
      if (!ch) {
        ch = { name, subscribed: false, sent: [], ...emitter() };
        if (name.startsWith('presence-')) ch.members = members();
        ch.trigger = (ev, data) => {
          if (!ch.subscribed) return false;
          ch.sent.push([ev, data]);
          return true;
        };
        channels.set(name, ch);
      }
      return ch;
    },
    unsubscribe(name) {
      log.push(['unsubscribe', name]);
      channels.delete(name);
    },
    channel(name) {
      return channels.get(name);
    },
    send_event(event, data, channel) {
      log.push(['send_event', event, data, channel]);
      return true;
    },
    disconnect() {
      log.push(['disconnect']);
      pusher.setState('disconnected');
    },
    setState(current) {
      const previous = connection.state;
      connection.state = current;
      connection.emit('state_change', { previous, current });
    },
    // Test helpers: complete a subscription, add/remove presence members.
    succeed(name, users = {}, myID) {
      const ch = channels.get(name);
      ch.subscribed = true;
      if (ch.members) {
        for (const [id, info] of Object.entries(users)) ch.members.map.set(id, info);
        ch.members.myID = myID;
        ch.members.count = ch.members.map.size;
      }
      ch.emit('pusher:subscription_succeeded', ch.members ?? {});
      return ch;
    },
    join(name, id, info) {
      const ch = channels.get(name);
      ch.members.map.set(id, info);
      ch.emit('pusher:member_added', { id, info });
    },
    leave(name, id) {
      const ch = channels.get(name);
      const info = ch.members.map.get(id);
      ch.members.map.delete(id);
      ch.emit('pusher:member_removed', { id, info });
    },
  };
  return pusher;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
