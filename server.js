// Server side of the stream protocol (see ./stream.js): send the output of an
// LLM, or any other stream of text, to a channel as it is produced, for
// Node backends that use the `pusher` package (any object with the same
// trigger(channel, event, data, params) method works).
// Kept identical in @hibira-io/react and @hibira-io/vue.
//
// Tokens are batched: one event per `interval` ms rather than one per token,
// so a model writing 50 tokens a second sends about 10 events a second. Each event
// stays under `maxBytes` (Free plans allow 4 KB per message), and events are
// sent one after another so they arrive in order.

const STREAM_EVENT = 'ai-stream';
const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s).length;

/**
 * Text of one chunk from the common LLM SDK streams, or '' when the chunk has
 * none (role markers, usage, tool calls...). Handles plain strings and bytes,
 * Anthropic (content_block_delta), OpenAI chat completions (choices[].delta)
 * and responses (response.output_text.delta), Gemini (chunk.text) and the
 * Vercel AI SDK (textStream yields strings; fullStream text-delta parts).
 */
export function textOf(chunk, decoder) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return decoder.decode(chunk, { stream: true });
  if (chunk.type === 'content_block_delta') return chunk.delta?.type === 'text_delta' ? chunk.delta.text ?? '' : '';
  if (chunk.type === 'response.output_text.delta') return chunk.delta ?? '';
  if (chunk.type === 'text-delta') return chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
  if (Array.isArray(chunk.choices)) return chunk.choices[0]?.delta?.content ?? '';
  if (typeof chunk.text === 'string') return chunk.text;
  return '';
}

function iterate(source) {
  if (source && typeof source[Symbol.asyncIterator] === 'function') return source;
  if (source && typeof source[Symbol.iterator] === 'function' && typeof source !== 'string') return source;
  if (source && typeof source.getReader === 'function') {
    return (async function* () {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  throw new TypeError('streamToChannel: source must be an async iterable, an iterable or a ReadableStream');
}

// Split text so each piece's JSON-escaped size fits `budget` bytes, without
// cutting a character in two.
function split(text, budget) {
  const out = [];
  let piece = '';
  let size = 0;
  for (const ch of text) {
    const n = bytes(JSON.stringify(ch)) - 2;
    if (size + n > budget && piece) {
      out.push(piece);
      piece = '';
      size = 0;
    }
    piece += ch;
    size += n;
  }
  if (piece) out.push(piece);
  return out;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Send a stream of text to a channel as events the useStream() hook and
 * composable put back together.
 *
 * @param {object} pusher a `pusher` (Node) instance
 * @param {string} channel channel to send to, e.g. "private-chat-42"
 * @param {AsyncIterable|Iterable|ReadableStream} source text chunks, or an LLM SDK stream (see textOf)
 * @param {object} [options]
 * @param {string} [options.id] stream id (default a random UUID); also returned
 * @param {string} [options.event="ai-stream"] event name
 * @param {number} [options.interval=100] ms to gather tokens before sending them
 * @param {number} [options.maxBytes=3500] largest event payload, in bytes
 * @param {any} [options.meta] JSON sent with the first event (model, message id, author...)
 * @param {(chunk: any) => string} [options.pick] text of one chunk, when textOf does not fit
 * @param {string} [options.socketId] leave out this connection (the sender's own tab)
 * @param {AbortSignal} [options.signal] stop reading; the stream ends with error "aborted"
 * @returns {Promise<{id: string, text: string, events: number}>} after the last event is sent
 */
export async function streamToChannel(pusher, channel, source, options = {}) {
  const {
    id = randomId(),
    event = STREAM_EVENT,
    interval = 100,
    maxBytes = 3500,
    meta,
    pick,
    socketId,
    signal,
  } = options;
  const params = socketId ? { socket_id: socketId } : undefined;
  const decoder = new TextDecoder();
  const envelope = bytes(JSON.stringify({ id, seq: 1e9, delta: '', meta }));
  const budget = maxBytes - envelope;
  if (budget < 16) throw new RangeError('streamToChannel: maxBytes is too small for the id and meta');

  let seq = 0;
  let text = '';
  let buffer = '';
  let timer = null;
  let chain = Promise.resolve();
  let sendError = null;

  const send = (payload) => {
    chain = chain.then(async () => {
      if (sendError) return;
      try {
        await pusher.trigger(channel, event, payload, params);
      } catch (err) {
        sendError = err;
      }
    });
    return chain;
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buffer) return;
    for (const delta of split(buffer, budget)) {
      const payload = { id, seq: seq++, delta };
      if (payload.seq === 0 && meta !== undefined) payload.meta = meta;
      send(payload);
    }
    buffer = '';
  };

  let error = null;
  try {
    for await (const chunk of iterate(source)) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (sendError) throw sendError;
      const delta = pick ? pick(chunk) ?? '' : textOf(chunk, decoder);
      if (!delta) continue;
      text += delta;
      buffer += delta;
      if (bytes(buffer) >= budget) flush();
      else if (!timer) timer = setTimeout(flush, interval);
    }
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      buffer += tail;
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  } catch (err) {
    error = err;
  }
  flush();

  const done = { id, seq, done: true };
  if (seq === 0 && meta !== undefined) done.meta = meta;
  if (error) done.error = signal?.aborted ? 'aborted' : String(error?.message ?? error);
  // The whole text lets late subscribers catch up; skip it when too big.
  if (bytes(JSON.stringify({ ...done, text })) <= maxBytes) done.text = text;
  seq++;
  await send(done);

  if (error) throw error;
  if (sendError) throw sendError;
  return { id, text, events: seq };
}

