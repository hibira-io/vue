# @hibira-io/vue

[![npm](https://img.shields.io/npm/v/@hibira-io/vue)](https://www.npmjs.com/package/@hibira-io/vue)
[![ci](https://github.com/hibira-io/vue/actions/workflows/ci.yml/badge.svg)](https://github.com/hibira-io/vue/actions/workflows/ci.yml)

Vue composables for [pusher-js](https://github.com/pusher/pusher-js) on
[Hibira](https://hibira.io), or any Pusher-compatible server: one connection
for the app, channels shared between components, events, presence members,
connection state and client events. It also streams LLM output to the
browser: `streamToChannel()` sends tokens from your backend in batched
events, and `useStream()` puts them back together, for every tab and every
person on the channel at once.

- Vue 3 and Vue 2.7 (which has the Composition API built in).
- Server rendering safe: nothing connects on the server. For Nuxt 3, 4 and 2,
  [@hibira-io/nuxt](https://github.com/hibira-io/nuxt) wires this up for you.
- Channel names can be refs or getters; the subscription follows them.
- Works with Laravel Echo: pass `echo.connector.pusher` as the client.
- Plain ESM with TypeScript types, no build step, no dependencies besides
  `pusher-js`.

Using React? See [@hibira-io/react](https://github.com/hibira-io/react).

## Install

```sh
npm install @hibira-io/vue pusher-js
```

## Setup

The app key is in the Hibira portal; it is public.

```js
// Vue 3
import { createApp } from 'vue';
import { createHibira } from '@hibira-io/vue';

createApp(App)
  .use(createHibira({
    appKey: import.meta.env.VITE_HIBIRA_KEY,
    options: { channelAuthorization: { endpoint: '/api/hibira/auth', transport: 'ajax' } },
  }))
  .mount('#app');
```

```js
// Vue 2.7
import Vue from 'vue';
import { createHibira } from '@hibira-io/vue';

Vue.use(createHibira({ appKey: process.env.VUE_APP_HIBIRA_KEY }));
```

`options` are [pusher-js options](https://github.com/pusher/pusher-js#configuration),
merged over the Hibira defaults (`wsHost: 'ws.hibira.io'`, `forceTLS`, and the
`cluster` pusher-js insists on). For a local server set `wsHost`, `wsPort` and
`forceTLS: false`. The connection opens the first time a component needs it.

With Laravel Echo, reuse its connection:

```js
app.use(createHibira({ client: () => window.Echo.connector.pusher }));
```

## Composables

```vue
<script setup>
import { ref } from 'vue';
import { useEvent, usePresence, useTrigger, useConnectionState } from '@hibira-io/vue';

const props = defineProps({ roomId: String });
const orders = ref([]);
useEvent('orders', 'order.created', (order) => orders.value.unshift(order));

const room = () => `presence-room-${props.roomId}`; // follows the prop
const { members, others, me, count } = usePresence(room);
const trigger = useTrigger(room);
useEvent(room, 'client-typing', (data, { user_id }) => showTyping(user_id));

const state = useConnectionState(); // 'connecting' | 'connected' | 'unavailable' | ...
</script>

<template>
  <span :class="state" /> {{ count }} here
  <input @input="trigger('client-typing', {})" />
</template>
```

| Composable | Returns |
| --- | --- |
| `usePusher()` | the pusher-js client, or `null` on the server |
| `useChannel(name)` | a ref to the channel; subscribed while the component lives, shared by every component using the same name; `null` subscribes to nothing |
| `useEvent(channel, event, handler)` | the channel ref; calls `handler(data, metadata)` |
| `usePresence(channel)` | refs `{ members, others, me, count, channel }`; members are `{ id, info, me }`, you first; `info` is the `user_info` your auth endpoint signed |
| `useTrigger(channel)` | `trigger('client-…', data)`, `false` until subscribed; turn on client events for the app in the portal |
| `useConnectionState()` | a ref: `'initialized'`, `'connecting'`, `'connected'`, `'unavailable'`, `'failed'` or `'disconnected'` |
| `useStream(channel, { id, event, rewind })` | refs `{ text, done, error, stream, streams, history }` and `reset()`, see below |
| `useAgentStream(channel, { invocationId, rewind })` | `{ text, reasoning, status, done, error, toolCalls, approvals, run, runs, history, reset }` for Laravel AI SDK agents, see below |

Wherever a composable takes a channel, pass a name (it subscribes), a
channel object you already have (Echo's `Echo.private('x').subscription`), or
a ref or getter of either. They also work inside `effectScope()` outside
components; the scope's `stop()` cleans up.

## Auth endpoint

Private and presence channels need a route on your backend that checks who
is signed in and signs the subscription. `endpoint` in `channelAuthorization`
points to it. With Express:

```js
import express from 'express';
import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env.HIBIRA_APP_ID,
  key: process.env.HIBIRA_KEY,
  secret: process.env.HIBIRA_SECRET,
  host: 'ws.hibira.io', // the host shown on your app page
  useTLS: true,
});

const app = express();
app.post('/api/hibira/auth', express.urlencoded({ extended: false }), (req, res) => {
  const user = req.user; // your session check
  if (!user) return res.sendStatus(401);
  const { socket_id, channel_name } = req.body;
  if (!mayJoin(user, channel_name)) return res.sendStatus(403);
  const presence = channel_name.startsWith('presence-')
    ? { user_id: String(user.id), user_info: { name: user.name } }
    : undefined;
  res.json(pusher.authorizeChannel(socket_id, channel_name, presence));
});
```

The app ID and key are on the app's page in the Hibira portal; the secret
is shown only once, when you create the app, so store it in your backend's
environment then. On the Free plan, add your site's origin (for example
`http://localhost:5173`) to the app's allowed origins, or browsers can't
connect. Using Nuxt? [@hibira-io/nuxt](https://github.com/hibira-io/nuxt)
has the auth route ready to fill in.

## Streaming LLM output

Send the model's stream from your backend with `streamToChannel()`. It
takes the stream of the Anthropic, OpenAI and Gemini SDKs and the Vercel AI
SDK as they are, an async iterable of strings, or a `ReadableStream`.

```js
// server/api/ask.post.js (Nuxt); any Node backend works the same way
import Pusher from 'pusher';
import OpenAI from 'openai';
import { streamToChannel } from '@hibira-io/vue/server';

const pusher = new Pusher({
  appId: process.env.HIBIRA_APP_ID,
  key: process.env.HIBIRA_KEY,
  secret: process.env.HIBIRA_SECRET,
  host: 'ws.hibira.io', // the host shown on your app page
  useTLS: true,
});
const openai = new OpenAI();

export default defineEventHandler(async (event) => {
  const { conversationId, question } = await readBody(event);
  const stream = await openai.chat.completions.create({
    model: 'gpt-5',
    stream: true,
    messages: [{ role: 'user', content: question }],
  });
  // Don't await: answer the request now and keep streaming to the channel.
  const id = crypto.randomUUID();
  event.waitUntil(
    streamToChannel(pusher, `private-conversation-${conversationId}`, stream, { id, meta: { role: 'assistant' } })
      .catch((err) => console.error('stream failed', err)),
  );
  return { id };
});
```

Then in the browser:

```vue
<script setup>
import { useStream } from '@hibira-io/vue';

const props = defineProps({ conversationId: String });
const { text, done, error } = useStream(() => `private-conversation-${props.conversationId}`);
</script>

<template>
  <p :aria-busy="!done">{{ text }}<em v-if="error"> (stopped: {{ error }})</em></p>
</template>
```

Every subscriber sees the same answer as it is written: other tabs, other
devices, teammates in a shared conversation. `useStream()` follows the stream
that started last; pass `{ id }` (a value, ref or getter) to follow one, or
read `streams` for all of them (by id, each
`{ id, text, done, error, meta, incomplete }`).

`streamToChannel(pusher, channel, source, options)` options:

| Option | Default | |
| --- | --- | --- |
| `id` | random UUID | stream id, also returned |
| `event` | `'ai-stream'` | event name |
| `interval` | `100` | ms to gather tokens into one event |
| `maxBytes` | `3500` | largest event; Free plans allow 4 KB per message |
| `meta` | | JSON sent with the first event (model, message id, author) |
| `pick` | | `(chunk) => text` for a source it does not know |
| `socketId` | | leave out the sender's own connection |
| `signal` | | an `AbortSignal` to stop; subscribers get `error: 'aborted'` |

It resolves to `{ id, text, events }` once the last event is sent, and
rejects when the source or the HTTP API fails, after telling subscribers.

How it works: tokens are batched into one event per `interval` (100 ms by
default), so a model writing 50 tokens a second sends about 10 events a
second rather than 50. Each event carries a sequence number and
`useStream()` applies them in order. The last event carries the whole text
when it fits in one message, so someone who subscribed halfway through, or
whose connection dropped for a moment, still ends with the full answer;
otherwise their stream is marked `incomplete`.

### Reloads and dropped connections: `rewind`

Turn on channel history for the app (app settings in the Hibira portal,
Hobby plans and up) and pass `rewind`, and nothing is lost: a page reloaded
halfway through an answer, or a phone that lost signal for a few seconds,
picks the answer up from its first token.

```js
const { text, done, history } = useStream(() => `private-conversation-${props.conversationId}`, { rewind: true });
```

Each time the channel is subscribed, the first time and again after a
reconnect, `useStream()` asks the server for the events it missed
(`pusher:rewind`): the last 300 seconds the first time, the time since the
last event after a reconnect. Live events are held for that moment and
everything is applied in order, without duplicates.

| `rewind` option | Default | |
| --- | --- | --- |
| `seconds` | `300` | history asked for on the first subscription (the app's history window caps it) |
| `limit` | all kept | at most this many events |
| `timeout` | `5000` | ms to wait for the server before going on without history |

`history` is a ref to the last answer: `{ count, window, complete }`, or
`{ error }` when history is off or not in the app's plan (the stream then
works as without `rewind`). Replayed events reach every listener on the
channel. `followStream(channel, { apply, rewind })` does the same for any
pusher-js channel.

Use a private or presence channel for anything personal, so only the people
your auth endpoint allows can subscribe.

## Laravel AI SDK agents: `useAgentStream`

For agents built with the [Laravel AI SDK](https://github.com/laravel/ai)
and broadcast with [`hibira-io/laravel`](https://github.com/hibira-io/laravel):

```php
// Laravel: queue the agent, stream its events to the user's private channel
use Hibira\Laravel\Ai\AgentChannel;

(new SalesCoach)->broadcastOnQueue($request->input('prompt'), AgentChannel::user($request->user()));
```

```js
// in setup(): every field is a ref
const { text, reasoning, status, toolCalls, approvals, error } = useAgentStream(
  `private-hibira-ai.user.${user.id}`,
  { rewind: true },
);
```

It listens to every Laravel AI stream event (`text_delta`,
`reasoning_delta`, `tool_call`, `tool_result`, `tool_approval_request`,
`stream_end`, errors) and puts each run (one `invocation_id`) back together.
`status` is `idle`, `streaming`, `awaiting_approval`, `done` or `error`;
`run.parts` lists text, reasoning and tool calls in the order they started,
for rendering a chat transcript. Events bigger than the plan's per-event
limit (4 KB on Free) arrive split into `hibira:chunk` events, which are
joined; replays from `rewind` are dropped by event id.

| Option | Default | |
| --- | --- | --- |
| `invocationId` | | follow only this run (a value, ref or getter); otherwise the one that started last |
| `rewind` | off | as for `useStream()` |
| `maxRuns` | `20` | runs kept, oldest dropped first |
| `events` | | extra event names, such as a provider's own error types |

`createAgentStore(onChange)` is the same without Vue, for any pusher-js
channel.

## Vue 2 notes

Vue 2 plugins are global, so every component uses the plugin installed last;
one connection per page is the usual setup anyway.

## Licence

MIT
