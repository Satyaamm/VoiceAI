/**
 * ElevenLabs streaming TTS adapter.
 *
 * Role in the ladder: ElevenLabs is the *fallback* TTS, not the primary.
 * docs/04 puts Cartesia first on TTFB and TTS is the biggest per-minute cost
 * line — ElevenLabs is roughly 2-3x the price. What it buys us is breadth:
 * it is the only vendor in this set that covers the Nordic and Polish tail
 * docs/13 §4 lists, so it is also the *primary* for those languages.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (eleven_multilingual_v2 / flash_v2_5 — ships to customers):
 *     en-US, en-GB, de-DE, fr-FR, es-ES, it-IT, pt-PT, pt-BR, pl-PL, nl-NL
 *   Passable (fine for internal/demo, prosody and register are inconsistent —
 *   the du/Sie, tu/vous problem in docs/13 §4 is NOT solved by any vendor here;
 *   register control is our text-normalization layer's job):
 *     sv-SE, da-DK, no-NO, fi-FI, cs-CZ, tr-TR, ro-RO, el-GR, uk-UA
 *   Note: flash_v2_5 trades a little naturalness for ~half the latency. For
 *   telephony that is the right trade; use multilingual_v2 only when a customer
 *   explicitly prefers quality over responsiveness.
 *
 * RESIDENCY: ElevenLabs offers an EU residency host. The factory only marks the
 * provider EU-eligible when that host is configured — an EU-residency workspace
 * must not silently egress to the US default.
 */

import type { AudioChunk, TtsProvider } from '../types.js';

export interface ElevenLabsTtsOptions {
  apiKey: string;
  baseUrl: string;
  /** eleven_flash_v2_5 (lowest latency) or eleven_multilingual_v2 (quality). */
  modelId: string;
  sampleRate: number;
  /** 0-1; higher = more consistent, less expressive. */
  stability: number;
  similarityBoost: number;
}

interface ElevenLabsVoice {
  voice_id?: unknown;
  name?: unknown;
  preview_url?: unknown;
  labels?: unknown;
  fine_tuning?: unknown;
}

/** ElevenLabs accepts a fixed set of raw-PCM sample rates. */
const SUPPORTED_PCM_RATES = new Set([8000, 16000, 22050, 24000, 44100]);

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly key = 'elevenlabs-tts';
  readonly label = 'ElevenLabs (streaming TTS)';

  /** Native-quality only — see the header comment for the passable set. */
  readonly languages = [
    'en-US',
    'en-GB',
    'de-DE',
    'fr-FR',
    'es-ES',
    'it-IT',
    'pt-PT',
    'pt-BR',
    'pl-PL',
    'nl-NL',
  ];

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    if (!SUPPORTED_PCM_RATES.has(opts.sampleRate)) {
      throw new Error(
        `elevenlabs: unsupported pcm sample rate ${opts.sampleRate}; ` +
          `expected one of ${[...SUPPORTED_PCM_RATES].join(', ')}`,
      );
    }
  }

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    const response = await fetch(new URL('/v1/voices', this.opts.baseUrl), {
      headers: { 'xi-api-key': this.opts.apiKey },
    });
    if (!response.ok) {
      throw new Error(`elevenlabs: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();
    const rows =
      payload && typeof payload === 'object' && Array.isArray((payload as { voices?: unknown }).voices)
        ? ((payload as { voices: unknown[] }).voices)
        : [];

    const voices = rows
      .filter((r): r is ElevenLabsVoice => !!r && typeof r === 'object')
      .map((v) => {
        const labels =
          v.labels && typeof v.labels === 'object' ? (v.labels as Record<string, unknown>) : {};
        const gender = typeof labels['gender'] === 'string' ? labels['gender'] : undefined;
        // Voices are multilingual; `labels.language` is only sometimes set, so
        // an unlabelled voice is treated as available in every language.
        const voiceLanguage = typeof labels['language'] === 'string' ? labels['language'] : '';
        const preview = typeof v.preview_url === 'string' ? v.preview_url : undefined;
        return {
          id: str(v.voice_id),
          name: str(v.name),
          language: voiceLanguage,
          ...(gender ? { gender } : {}),
          ...(preview ? { preview } : {}),
        };
      })
      .filter((v) => v.id);

    if (!language) return voices;
    const short = shortLanguage(language);
    return voices.filter((v) => !v.language || shortLanguage(v.language) === short);
  }

  async *stream(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk> {
    if (streamOpts.signal?.aborted) return;

    const url = new URL(
      `/v1/text-to-speech/${encodeURIComponent(streamOpts.voiceId)}/stream`,
      this.opts.baseUrl,
    );
    url.searchParams.set('output_format', `pcm_${this.opts.sampleRate}`);
    // Chunk as soon as possible; we feed at clause boundaries already, so we
    // do not want the vendor buffering for lookahead on our behalf.
    url.searchParams.set('optimize_streaming_latency', '3');

    const voiceSettings: Record<string, unknown> = {
      stability: this.opts.stability,
      similarity_boost: this.opts.similarityBoost,
    };
    if (streamOpts.speed !== undefined) voiceSettings['speed'] = streamOpts.speed;

    const body: Record<string, unknown> = {
      text: streamOpts.text,
      model_id: this.opts.modelId,
      voice_settings: voiceSettings,
      language_code: shortLanguage(streamOpts.language),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.opts.apiKey,
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`elevenlabs: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* pcm16Frames(response.body, this.opts.sampleRate, streamOpts.signal);
  }
}

/**
 * Decodes signed 16-bit little-endian PCM into float AudioChunks, carrying a
 * partial sample across reads. Aborts stop production immediately (barge-in).
 */
async function* pcm16Frames(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  signal?: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const reader = body.getReader();
  let carry = new Uint8Array(0);
  let sequence = 0;
  try {
    for (;;) {
      if (signal?.aborted) return;
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

      const usable = bytes.byteLength - (bytes.byteLength % 2);
      if (usable > 0) {
        const samples = new Float32Array(usable / 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        yield { data: samples, sampleRate, sequence: sequence++ };
      }
      carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
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

export function createElevenLabsTts(opts: ElevenLabsTtsOptions): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider(opts);
}
