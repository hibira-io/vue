// Compiled by `npm run typecheck`, never run.
import { createApp, ref } from 'vue';
import { createHibira, useAgentStream, useChannel, useEvent, usePresence, useStream, useTrigger, useConnectionState, usePusher } from '@hibira-io/vue';
import { streamToChannel } from '@hibira-io/vue/server';

createApp({}).use(createHibira({ appKey: 'key', options: { channelAuthorization: { endpoint: '/auth', transport: 'ajax' } } }));

export function setup() {
  const id = ref(1);
  const channel = useChannel(() => `private-order-${id.value}`);
  useEvent<{ text: string }>(channel, 'message', (m) => m.text.toUpperCase());
  const { members, me } = usePresence<{ name: string }>('presence-room');
  const names: (string | undefined)[] = members.value.map((m) => m.info?.name);
  const trigger = useTrigger('private-chat');
  trigger('client-typing', {});
  const { text, done, stream } = useStream<{ model: string }>('private-ai', { id: ref('s1') });
  const agent = useAgentStream('private-hibira-ai.user.1', { rewind: { seconds: 60 }, invocationId: ref('inv') });
  const agentText: string = agent.text.value;
  const agentStatus: 'idle' | 'streaming' | 'awaiting_approval' | 'done' | 'error' = agent.status.value;
  const firstTool: string | undefined = agent.toolCalls.value[0]?.name ?? undefined;
  const model: string | undefined = stream.value?.meta?.model;
  const state: string = useConnectionState().value;
  return { names, me: me.value?.id, text: text.value, done: done.value, model, state, pusher: usePusher() };
}

export async function server(pusher: { trigger(c: string, e: string, d: any, x?: any): Promise<any> }) {
  const r = await streamToChannel(pusher, 'private-ai', ['a', 'b'], { meta: { model: 'm' } });
  return r.id + r.text;
}
