export interface Stream<Meta = any> {
  id: string;
  /** Text so far; the whole text once done. */
  text: string;
  done: boolean;
  /** Set when the source failed or was aborted. */
  error: string | null;
  /** The meta passed to streamToChannel(). */
  meta: Meta | null;
  /** Chunks were missed (subscribed late, reconnected) and the final event was too big to carry the whole text. */
  incomplete: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface StreamPayload {
  id: string;
  seq: number;
  delta?: string;
  done?: boolean;
  text?: string;
  error?: string;
  meta?: any;
}

export interface StreamStore {
  apply(payload: StreamPayload): void;
  readonly streams: Record<string, Stream>;
  reset(): void;
}

export const STREAM_EVENT: 'ai-stream';

export function createStreamStore(
  onChange: (streams: Record<string, Stream>, changed: Stream | null) => void,
  options?: { maxStreams?: number },
): StreamStore;

export const REWIND_SLACK: number;

export interface RewindOptions {
  /** Seconds of history asked for on the first subscription, default 300 (the server caps it at the app's history window). */
  seconds?: number;
  /** At most this many events per rewind; default all that are kept. */
  limit?: number;
  /** Milliseconds to hold live events while waiting for the answer, default 5000. */
  timeout?: number;
}

/** pusher:rewind_succeeded's data, or `error` when history is off, not in the plan, or did not answer. */
export type HistoryResult = { count: number; window: number; complete: boolean; error?: undefined } | { error: string };

export function followStream(
  channel: any,
  options: {
    apply(payload: any, event: string): void;
    /** One event name or several; default "ai-stream". */
    event?: string | string[];
    rewind?: boolean | RewindOptions;
    client?: any;
    onHistory?(result: HistoryResult): void;
  },
): () => void;
