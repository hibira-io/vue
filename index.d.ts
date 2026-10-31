import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type Pusher from 'pusher-js';
import type { Options } from 'pusher-js';
import type { Member } from './client.js';
import type { HistoryResult, RewindOptions, Stream } from './stream.js';

export type { Member } from './client.js';
export type { HistoryResult, RewindOptions, Stream, StreamPayload, StreamStore } from './stream.js';
export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore, followStream } from './stream.js';

/** A pusher-js channel (PresenceChannel and PrivateChannel included). */
export type Channel = ReturnType<Pusher['subscribe']>;
/** A value, a ref, or a getter. */
export type Source<T> = T | Ref<T> | (() => T);
/** A channel name to subscribe to, a channel to use as is, or null for none. */
export type ChannelTarget = Source<string | Channel | null | undefined>;

export type ConnectionState = 'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed' | 'disconnected';

export interface HibiraConfig {
  /** App key from the Hibira portal. */
  appKey?: string;
  /** pusher-js options merged over HIBIRA_DEFAULTS. */
  options?: Partial<Options>;
  /** Use this client (or the one this returns) instead, e.g. `echo.connector.pusher`. Not disconnected by disconnect(). */
  client?: Pusher | (() => Pusher);
}

export interface Hibira {
  /** The pusher-js client; opened on first use in the browser, null on the server. */
  readonly client: Pusher | null;
  /** Disconnects a client this plugin opened. */
  disconnect(): void;
  /** Vue 3 app.use() / Vue 2.7 Vue.use(). */
  install(app: any): void;
}

export const HIBIRA_KEY: unique symbol;

export function createHibira(config?: HibiraConfig): Hibira;
export function useHibira(): Hibira | null;
/** The pusher-js client, or null on the server or without a plugin. */
export function usePusher(): Pusher | null;

/** Subscribes while the component or effect scope lives; one subscription per name. */
export function useChannel(name: Source<string | null | undefined>): ShallowRef<Channel | null>;

export function useEvent<T = any>(
  target: ChannelTarget,
  event: Source<string | null | undefined>,
  handler: (data: T, metadata?: { user_id?: string }) => void,
): ComputedRef<Channel | null>;

export function useConnectionState(): ShallowRef<ConnectionState>;

export interface Presence<Info = any> {
  channel: ComputedRef<Channel | null>;
  /** You first. */
  members: ShallowRef<Member<Info>[]>;
  others: ComputedRef<Member<Info>[]>;
  me: ComputedRef<Member<Info> | null>;
  count: ComputedRef<number>;
}

export function usePresence<Info = any>(target: ChannelTarget): Presence<Info>;

/** Sends a client event ("client-..."); false when not subscribed yet. */
export function useTrigger(target: ChannelTarget): (event: `client-${string}`, data?: any) => boolean;

export interface UseStreamOptions {
  /** Default "ai-stream". */
  event?: string;
  /** Follow only this stream. */
  id?: Source<string | null | undefined>;
  /** Streams kept, default 50. */
  maxStreams?: number;
  /**
   * Catch up from channel history (pusher:rewind) on each subscription, so a
   * reload or a dropped connection does not lose chunks. Needs channel
   * history on for the app (Hobby plans and up).
   */
  rewind?: boolean | RewindOptions;
}

export interface StreamState<Meta = any> {
  channel: ComputedRef<Channel | null>;
  /** The stream with `id`, or else the one that started last. */
  stream: ComputedRef<Stream<Meta> | null>;
  streams: ShallowRef<Record<string, Stream<Meta>>>;
  text: ComputedRef<string>;
  done: ComputedRef<boolean>;
  error: ComputedRef<string | null>;
  /** The last rewind's result, or null before one (or without `rewind`). */
  history: ShallowRef<HistoryResult | null>;
  /** Forget every stream. */
  reset(): void;
}

export function useStream<Meta = any>(target: ChannelTarget, options?: UseStreamOptions): StreamState<Meta>;

declare module 'vue' {
  interface ComponentCustomProperties {
    $hibira: Hibira;
  }
}
