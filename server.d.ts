export interface StreamToChannelOptions {
  /** Stream id, default a random UUID. */
  id?: string;
  /** Event name, default "ai-stream". */
  event?: string;
  /** ms to gather tokens before sending them, default 100. */
  interval?: number;
  /** Largest event payload in bytes, default 3500 (Free plans allow 4 KB). */
  maxBytes?: number;
  /** JSON sent with the first event (model, message id, author...). */
  meta?: any;
  /** Text of one chunk, when textOf() does not understand the source. */
  pick?: (chunk: any) => string | null | undefined;
  /** Leave out this connection (the sender's own tab). */
  socketId?: string;
  /** Stop reading; the stream ends with error "aborted" and the promise rejects. */
  signal?: AbortSignal;
}

export interface StreamResult {
  id: string;
  /** The whole text that was sent. */
  text: string;
  /** Events sent, including the final one. */
  events: number;
}

/** Anything with the `pusher` package's trigger method. */
export interface Triggerer {
  trigger(channel: string, event: string, data: any, params?: { socket_id?: string }): Promise<any>;
}

/**
 * Send a stream of text (an LLM SDK stream, an async iterable of strings, a
 * ReadableStream) to a channel in batched events that useStream() puts back
 * together.
 */
export function streamToChannel(
  pusher: Triggerer,
  channel: string,
  source: AsyncIterable<any> | Iterable<any> | ReadableStream<any>,
  options?: StreamToChannelOptions,
): Promise<StreamResult>;

/**
 * Text of one chunk from common LLM SDK streams (Anthropic, OpenAI chat and
 * responses, Gemini, Vercel AI SDK), strings and bytes; '' when it has none.
 */
export function textOf(chunk: any, decoder?: TextDecoder): string;
