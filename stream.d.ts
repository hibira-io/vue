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
