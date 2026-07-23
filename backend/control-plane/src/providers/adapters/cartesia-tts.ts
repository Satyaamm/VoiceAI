/**
 * Cartesia streaming TTS adapter.
 *
 * docs/04 picks Cartesia for Phase 1 specifically because it has the lowest
 * TTFB of the vendors — TTS sits at the end of the turn, so its time-to-first-
 * byte is felt directly by the caller.
 *
 * Two things this adapter must get right:
 *
 *   1. STREAM, never buffer. We yield audio frames as they arrive off the
 *      socket. Waiting for the full utterance would add its entire duration to
 *      perceived latency.
 *   2. CANCEL INSTANTLY on `signal`. Barge-in truncation (docs/02) means the
 *      caller started talking and we must stop mid-word. We abort the fetch AND
 *      cancel the body reader, so no further frames are produced and nothing
 *      keeps the socket alive.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (prosody and register hold up in front of a customer):
 *     en-US, en-GB, es-ES, fr-FR, de-DE, pt-BR
 *   Passable (intelligible, but prosody drifts — German compound nouns and
 *   Dutch number reading are the visible failures; do not ship to a Frankfurt
 *   or Amsterdam enterprise without an eval):
 *     it-IT, nl-NL, pl-PL, sv-SE, tr-TR, ru-RU, ja-JP, zh-CN, ko-KR, hi-IN
 *   Not offered at all: da-DK, no-NO, fi-FI — the Nordic enterprise tail in
 *   docs/13 §4 is a genuine coverage gap for this vendor.
 *
 * RESIDENCY: US-hosted only. The factory marks `allowedBlocs: ['US']`.
 */

import type { AudioChunk, TtsProvider } from '../types.js';

/** Cartesia pins breaking changes behind a dated version header. */
const CARTESIA_VERSION = '2024-11-13';

export interface CartesiaTtsOptions {
  apiKey: string;
  baseUrl: string;
  /** sonic-2 is the current low-latency model. */
  modelId: string;
  sampleRate: number;
}

interface CartesiaVoice {
  id?: unknown;
  name?: unknown;
  language?: unknown;
  gender?: unknown;
  description?: unknown;
}

export class CartesiaTtsProvider implements TtsProvider {
  readonly key = 'cartesia-tts';
  readonly label = 'Cartesia Sonic (streaming TTS)';

  /** Native-quality only — see the header comment for the passable set. */
  readonly languages = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR'];

  constructor(private readonly opts: CartesiaTtsOptions) {}

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    const response = await fetch(new URL('/voices/', this.opts.baseUrl), {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`cartesia: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();
    // The endpoint has returned both a bare array and a {data:[...]} envelope
    // across versions; accept either rather than break the voice picker.
    const rows: unknown[] = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data)
        : [];

    const voices = rows
      .filter((r): r is CartesiaVoice => !!r && typeof r === 'object')
      .map((v) => {
        const gender = typeof v.gender === 'string' ? v.gender : undefined;
        return {
          id: str(v.id),
          name: str(v.name),
          language: str(v.language),
          ...(gender ? { gender } : {}),
        };
      })
      .filter((v) => v.id);

    return language ? voices.filter((v) => v.language === shortLanguage(language)) : voices;
  }

  async *stream(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk> {
    if (streamOpts.signal?.aborted) return;

    const body: Record<string, unknown> = {
      model_id: this.opts.modelId,
      transcript: streamOpts.text,
      voice: { mode: 'id', id: streamOpts.voiceId },
      language: shortLanguage(streamOpts.language),
      output_format: {
        container: 'raw',
        encoding: 'pcm_f32le',
        sample_rate: this.opts.sampleRate,
      },
    };
    const speed = mapSpeed(streamOpts.speed);
    if (speed) body['speed'] = speed;

    // Failures throw — the CircuitBreaker decides whether to fall back.
    const response = await fetch(new URL('/tts/bytes', this.opts.baseUrl), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`cartesia: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* pcmF32Frames(response.body, this.opts.sampleRate, streamOpts.signal);
  }

  private headers(): Record<string, string> {
    return {
      'X-API-Key': this.opts.apiKey,
      'Cartesia-Version': CARTESIA_VERSION,
    };
  }
}

/**
 * Cartesia takes a coarse speed enum rather than a multiplier.
 * NOTE: mapping thresholds are ours, not the vendor's.
 */
function mapSpeed(speed?: number): string | null {
  if (speed === undefined || Math.abs(speed - 1) < 0.05) return null;
  if (speed >= 1.15) return 'fast';
  if (speed <= 0.85) return 'slow';
  return 'normal';
}

/** 'de-DE' -> 'de'. Cartesia keys languages by the short code. */
function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
}

/**
 * Decodes a raw little-endian float32 byte stream into AudioChunks, carrying a
 * partial sample across reads (a TCP read boundary is not a sample boundary).
 */
async function* pcmF32Frames(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  signal?: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const reader = body.getReader();
  let carry = new Uint8Array(0);
  let sequence = 0;
  try {
    for (;;) {
      if (signal?.aborted) return; // barge-in: stop producing audio immediately
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let bytes: Uint8Array;
      if (carry.byteLength === 0) {
        bytes = value;
      } else {
        bytes = new Uint8Array(carry.byteLength + value.byteLength);
        bytes.set(carry, 0);
        bytes.set(value, carry.byteLength);
      }

      const usable = bytes.byteLength - (bytes.byteLength % 4);
      if (usable > 0) {
        const samples = new Float32Array(usable / 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
        yield { data: samples, sampleRate, sequence: sequence++ };
      }
      carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createCartesiaTts(opts: CartesiaTtsOptions): CartesiaTtsProvider {
  return new CartesiaTtsProvider(opts);
}
