/**
 * Deepgram streaming STT adapter.
 *
 * docs/04: STT is "buy in Phase 1, self-host Parakeet in Phase 2". That only
 * works if the vendor sits behind the same `SttProvider` seam as the eventual
 * self-hosted model — so nothing here leaks outside this file.
 *
 * Transport is a WebSocket because Deepgram's realtime API is a WebSocket, and
 * because anything request/response cannot meet the latency budget (docs/01 §1).
 *
 * LANGUAGE QUALITY (docs/13 §4 — non-English quality is the wedge, so this is
 * product metadata, not trivia):
 *   Native quality (nova-3 / nova-2 telephony-tuned, safe to sell):
 *     en-US, en-GB, en-AU, es-ES, es-419, fr-FR, de-DE, pt-BR, pt-PT, nl-NL,
 *     it-IT, hi-IN, ja-JP
 *   Passable (usable, but WER on telephony audio is materially worse — do NOT
 *   put these in front of a German/Nordic enterprise without an eval):
 *     pl-PL, sv-SE, da-DK, no-NO, tr-TR, ru-RU, uk-UA, cs-CZ
 *   Known weak spots: Bavarian / Swiss German, Québécois, Andalusian regional
 *   accents. These are exactly the accents docs/13 §4 says we must win, which
 *   is the argument for the Phase 2 self-hosted path.
 *
 * RESIDENCY: Deepgram's hosted API is US-only (their EU story is self-hosted
 * only), so the factory marks this provider `allowedBlocs: ['US']`. An EU
 * residency workspace must not be able to select it.
 */

import type {
  AudioChunk,
  SttProvider,
  SttSession,
  Transcript,
} from '../types.js';

// ---------------------------------------------------------------------------
// Minimal WebSocket seam
//
// Node 20 has `fetch` but NOT a global `WebSocket` (that landed in 22). We do
// not want to add a dependency just to typecheck, so we depend on this tiny
// structural interface and resolve an implementation at RUNTIME.
//
// TODO(runtime-dep): install `ws` and pass a factory:
//   import WebSocket from 'ws';
//   createDeepgramStt({ ..., webSocketFactory: (url, protos) =>
//     new WebSocket(url, protos) as unknown as MinimalWebSocket })
// or run on Node >= 22, where the global `WebSocket` satisfies this shape.
// ---------------------------------------------------------------------------

export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => MinimalWebSocket;

const WS_OPEN = 1;

/** Resolves a WebSocket implementation without importing one at build time. */
export function defaultWebSocketFactory(): WebSocketFactory {
  const g = globalThis as unknown as {
    WebSocket?: new (url: string, protocols?: string[]) => MinimalWebSocket;
  };
  const Impl = g.WebSocket;
  if (!Impl) {
    throw new Error(
      'no WebSocket implementation available — run on Node >= 22 or pass ' +
        'webSocketFactory (npm i ws). See TODO(runtime-dep) in deepgram.ts.',
    );
  }
  return (url, protocols) => new Impl(url, protocols);
}

// ---------------------------------------------------------------------------

export interface DeepgramSttOptions {
  apiKey: string;
  /** nova-3 is the current low-latency multilingual model. */
  model: string;
  baseUrl: string;
  /** Deepgram's server-side endpointing, in ms. We still run our own. */
  endpointingMs: number;
  smartFormat: boolean;
  webSocketFactory?: WebSocketFactory;
}

interface DeepgramWord {
  word?: unknown;
  punctuated_word?: unknown;
  confidence?: unknown;
  start?: unknown;
  end?: unknown;
}

interface DeepgramAlternative {
  transcript?: unknown;
  confidence?: unknown;
  words?: unknown;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Float32 [-1,1] -> little-endian int16 PCM, the wire format we ask Deepgram for. */
function toLinear16(data: Float32Array | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data; // already encoded upstream
  const out = new Uint8Array(data.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) {
    const sample = data[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}

/**
 * Single-consumer async queue. Same shape as the mock's, because the trace a
 * consumer sees must not depend on which provider produced it.
 */
class TranscriptQueue {
  private readonly buffer: Transcript[] = [];
  private readonly waiters: Array<(r: IteratorResult<Transcript>) => void> = [];
  private failure: Error | null = null;
  private readonly errorWaiters: Array<(e: Error) => void> = [];
  private done = false;

  push(t: Transcript): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: t, done: false });
    else this.buffer.push(t);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    let w = this.waiters.shift();
    while (w) {
      w({ value: undefined as never, done: true });
      w = this.waiters.shift();
    }
  }

  /** Network/protocol failures propagate — the CircuitBreaker handles fallback. */
  fail(err: Error): void {
    if (this.done) return;
    this.failure = err;
    let w = this.errorWaiters.shift();
    while (w) {
      w(err);
      w = this.errorWaiters.shift();
    }
    this.finish();
  }

  next(): Promise<IteratorResult<Transcript>> {
    const queued = this.buffer.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.errorWaiters.push(reject);
    });
  }
}

// ---------------------------------------------------------------------------

export class DeepgramSttProvider implements SttProvider {
  readonly key = 'deepgram-stt';
  readonly label = 'Deepgram (streaming STT)';
  readonly streaming = true as const;

  /** Native-quality only. Passable languages are deliberately NOT advertised. */
  readonly languages = [
    'en-US',
    'en-GB',
    'en-AU',
    'de-DE',
    'fr-FR',
    'es-ES',
    'es-419',
    'it-IT',
    'nl-NL',
    'pt-PT',
    'pt-BR',
    'hi-IN',
    'ja-JP',
  ];

  private readonly wsFactory: WebSocketFactory;

  constructor(private readonly opts: DeepgramSttOptions) {
    this.wsFactory = opts.webSocketFactory ?? defaultWebSocketFactory();
  }

  async start(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession> {
    if (startOpts.signal?.aborted) throw new Error('deepgram: aborted before start');

    const url = this.buildUrl(startOpts);
    const socket = this.wsFactory(url, ['token', this.opts.apiKey]);

    const queue = new TranscriptQueue();
    /** Audio pushed before the socket opens — a phone call does not wait. */
    const pending: Uint8Array[] = [];
    let open = false;
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close(1000, 'client closed');
      } catch {
        /* already gone */
      }
      queue.finish();
    };

    // Barge-in: abort must stop this session immediately, not at the next frame.
    const onAbort = () => teardown();
    startOpts.signal?.addEventListener('abort', onAbort, { once: true });

    socket.onopen = () => {
      open = true;
      for (const frame of pending) {
        try {
          socket.send(frame);
        } catch {
          /* the error handler will surface it */
        }
      }
      pending.length = 0;
    };

    socket.onerror = () => {
      queue.fail(new Error('deepgram: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(new Error(`deepgram: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()));
      }
      closed = true;
      queue.finish();
    };

    socket.onmessage = (ev) => {
      const transcript = parseDeepgramMessage(ev.data, startOpts.language);
      if (transcript) queue.push(transcript);
    };

    const session: SttSession = {
      push(chunk: AudioChunk) {
        if (closed) return;
        const frame = toLinear16(chunk.data);
        if (open && socket.readyState === WS_OPEN) {
          socket.send(frame);
        } else {
          pending.push(frame);
        }
      },
      end() {
        if (closed) return;
        // Deepgram drains and emits the final transcript on CloseStream.
        try {
          if (socket.readyState === WS_OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
        } catch {
          /* nothing to drain */
        }
      },
      close() {
        startOpts.signal?.removeEventListener('abort', onAbort);
        teardown();
      },
      [Symbol.asyncIterator](): AsyncIterator<Transcript> {
        return { next: () => queue.next() };
      },
    };

    return session;
  }

  private buildUrl(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
  }): string {
    const url = new URL('/v1/listen', this.opts.baseUrl);
    const p = url.searchParams;
    p.set('model', this.opts.model);
    p.set('language', startOpts.language);
    p.set('encoding', 'linear16');
    p.set('sample_rate', String(startOpts.sampleRate));
    p.set('channels', '1');
    p.set('interim_results', 'true');
    p.set('punctuate', 'true');
    p.set('endpointing', String(this.opts.endpointingMs));
    if (this.opts.smartFormat) p.set('smart_format', 'true');

    // Contextual biasing (docs/03 2.9). nova-3 uses `keyterm`; nova-2 and older
    // use `keywords`. Both are repeated query params.
    if (startOpts.vocabulary?.length) {
      const param = this.opts.model.startsWith('nova-3') ? 'keyterm' : 'keywords';
      for (const term of startOpts.vocabulary) {
        if (term.trim()) p.append(param, term);
      }
    }

    // Slot-aware decoding (docs/03 §B). Deepgram exposes only coarse knobs —
    // real constrained decoding arrives with the self-hosted model.
    if (startOpts.expectedSlot === 'digits') {
      p.set('numerals', 'true');
      p.set('smart_format', 'false');
    }

    return url.toString();
  }
}

function parseDeepgramMessage(raw: unknown, language: string): Transcript | null {
  if (typeof raw !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload as Record<string, unknown>;
  if (msg['type'] !== 'Results') return null;

  const channel = msg['channel'];
  if (!channel || typeof channel !== 'object') return null;
  const alternatives = (channel as Record<string, unknown>)['alternatives'];
  if (!Array.isArray(alternatives)) return null;
  const alt = alternatives[0] as DeepgramAlternative | undefined;
  if (!alt) return null;

  const text = str(alt.transcript);
  if (!text) return null;

  const words = Array.isArray(alt.words)
    ? (alt.words as DeepgramWord[]).map((w) => ({
        word: str(w.punctuated_word) || str(w.word),
        confidence: num(w.confidence, 1),
        startMs: Math.round(num(w.start) * 1000),
        endMs: Math.round(num(w.end) * 1000),
      }))
    : undefined;

  return {
    text,
    isFinal: msg['is_final'] === true,
    confidence: num(alt.confidence, 0),
    language,
    ...(words && words.length ? { words } : {}),
  };
}

export function createDeepgramStt(opts: DeepgramSttOptions): DeepgramSttProvider {
  return new DeepgramSttProvider(opts);
}
