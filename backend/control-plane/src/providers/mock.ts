/**
 * Mock providers — a deterministic pipeline with realistic timing.
 *
 * These are not throwaway test doubles. They are how the simulator, the eval
 * harness, and the dashboard's trace viewer get exercised without touching a
 * vendor or a GPU. Timings mirror the budget in docs/01 §1, so a trace produced
 * here looks like a trace produced in production.
 */

import type {
  AudioChunk,
  ChatMessage,
  LlmDelta,
  LlmProvider,
  SttProvider,
  SttSession,
  Transcript,
  TtsProvider,
} from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

export class MockSttProvider implements SttProvider {
  readonly key = 'mock-stt';
  readonly label = 'Mock STT (simulator)';
  readonly streaming = true as const;
  readonly languages = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL'];

  constructor(private readonly script: string[] = []) {}

  async start(opts: { language: string; signal?: AbortSignal }): Promise<SttSession> {
    const queue: Transcript[] = [];
    const waiters: Array<(t: IteratorResult<Transcript>) => void> = [];
    let closed = false;

    const emit = (t: Transcript) => {
      const w = waiters.shift();
      if (w) w({ value: t, done: false });
      else queue.push(t);
    };

    // Emit partials the way a streaming transducer does: incrementally, DURING
    // the caller's speech, so the transcript is ready when they stop.
    const utterance = this.script.shift() ?? '';
    const words = utterance.split(' ').filter(Boolean);
    void (async () => {
      for (let i = 1; i <= words.length; i++) {
        if (closed || opts.signal?.aborted) return;
        await sleep(100);
        emit({
          text: words.slice(0, i).join(' '),
          isFinal: false,
          confidence: 0.9,
          language: opts.language,
        });
      }
      if (closed) return;
      emit({
        text: utterance,
        isFinal: true,
        confidence: 0.96,
        language: opts.language,
        words: words.map((word, i) => ({
          word,
          confidence: 0.9 + (i % 5) * 0.02,
          startMs: i * 200,
          endMs: (i + 1) * 200,
        })),
      });
      const w = waiters.shift();
      if (w) w({ value: undefined as never, done: true });
      closed = true;
    })();

    return {
      push(_chunk: AudioChunk) {
        /* audio ignored; the script drives the mock */
      },
      end() {
        closed = true;
      },
      close() {
        closed = true;
      },
      [Symbol.asyncIterator](): AsyncIterator<Transcript> {
        return {
          next(): Promise<IteratorResult<Transcript>> {
            const queued = queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------

export class MockLlmProvider implements LlmProvider {
  readonly key = 'mock-llm';
  readonly label = 'Mock LLM (simulator)';
  readonly models = ['mock-fast', 'mock-smart'];

  /** Prefix cache, keyed by agent id — mirrors the real prefix-caching behaviour. */
  private readonly warmPrefixes = new Set<string>();

  constructor(private readonly replies: string[] = []) {}

  async *stream(opts: {
    model: string;
    messages: ChatMessage[];
    cacheKey?: string;
    signal?: AbortSignal;
  }): AsyncIterable<LlmDelta> {
    const cacheHit = !!opts.cacheKey && this.warmPrefixes.has(opts.cacheKey);
    if (opts.cacheKey) this.warmPrefixes.add(opts.cacheKey);

    // Time-to-first-token: warm prefix ~90ms, cold ~250ms. This is the single
    // biggest lever in docs/01 §5, so the simulator models it explicitly.
    await sleep(cacheHit ? 90 : 250);
    if (opts.signal?.aborted) return;

    const reply = this.replies.shift() ?? 'Sure, let me help you with that.';
    const tokens = reply.match(/\S+\s*/g) ?? [];

    for (const token of tokens) {
      if (opts.signal?.aborted) return; // cancellation on barge-in
      await sleep(12); // ~80 tokens/sec
      yield { type: 'text', text: token };
    }

    const promptTokens = opts.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
    yield {
      type: 'done',
      usage: {
        promptTokens,
        cachedTokens: cacheHit ? Math.floor(promptTokens * 0.94) : 0,
        completionTokens: tokens.length,
      },
    };
  }
}

// ---------------------------------------------------------------------------

export class MockTtsProvider implements TtsProvider {
  readonly key = 'mock-tts';
  readonly label = 'Mock TTS (simulator)';
  readonly languages = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL'];

  async listVoices(language?: string) {
    const all = [
      { id: 'mock-en-f', name: 'Ava (EN)', language: 'en-US', gender: 'female' },
      { id: 'mock-en-m', name: 'Miles (EN)', language: 'en-US', gender: 'male' },
      { id: 'mock-de-f', name: 'Lena (DE)', language: 'de-DE', gender: 'female' },
      { id: 'mock-fr-f', name: 'Camille (FR)', language: 'fr-FR', gender: 'female' },
      { id: 'mock-es-m', name: 'Mateo (ES)', language: 'es-ES', gender: 'male' },
    ];
    return language ? all.filter((v) => v.language === language) : all;
  }

  async *stream(opts: { text: string; signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    // Time-to-first-byte ~80ms, then ~120ms of audio per chunk.
    await sleep(80);
    const chunks = Math.max(1, Math.ceil(opts.text.length / 20));
    for (let i = 0; i < chunks; i++) {
      if (opts.signal?.aborted) return; // barge-in cancels mid-utterance
      await sleep(40);
      yield {
        data: new Float32Array(1920), // 120ms @ 16kHz
        sampleRate: 16_000,
        sequence: i,
      };
    }
  }
}
