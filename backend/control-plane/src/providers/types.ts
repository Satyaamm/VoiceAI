/**
 * Provider interfaces — the seam between our pipeline and any vendor or self-hosted
 * model. docs/04: vendors are a fuse, not the architecture.
 *
 * Everything is streaming. A provider that can only do request/response cannot meet
 * the latency budget and does not belong behind these interfaces.
 */

export interface AudioChunk {
  /** 16kHz mono PCM float, or encoded frames for pass-through providers. */
  readonly data: Float32Array | Uint8Array;
  readonly sampleRate: number;
  readonly sequence: number;
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export interface Transcript {
  readonly text: string;
  /** Partials arrive every ~100ms; only `isFinal` is committed. */
  readonly isFinal: boolean;
  readonly confidence: number;
  /** Per-word confidence — drives targeted confirm-back (docs/03 §B 2.5). */
  readonly words?: Array<{ word: string; confidence: number; startMs: number; endMs: number }>;
  readonly language?: string;
}

export interface SttSession extends AsyncIterable<Transcript> {
  push(chunk: AudioChunk): void;
  /** Signal end of audio; the session drains and completes. */
  end(): void;
  close(): void;
}

export interface SttProvider {
  readonly key: string;
  readonly label: string;
  readonly streaming: true;
  /** Languages this provider handles at native quality — docs/13 §4. */
  readonly languages: string[];
  start(opts: {
    language: string;
    sampleRate: number;
    /** Contextual biasing: product names, SKUs (docs/03 2.9). */
    vocabulary?: string[];
    /** Slot-aware constrained decoding (docs/03 §B). */
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | {
      type: 'done';
      usage: {
        promptTokens: number;
        /** Prefix-cache hits — the cost and latency lever (docs/01 §5). */
        cachedTokens: number;
        completionTokens: number;
      };
    };

export interface LlmProvider {
  readonly key: string;
  readonly label: string;
  readonly models: string[];
  /**
   * `cacheKey` scopes the prefix cache, normally the agent id. Same agent =>
   * same system prompt and tool schemas => ~40-token prefill instead of ~4,000.
   */
  stream(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    cacheKey?: string;
    signal?: AbortSignal;
  }): AsyncIterable<LlmDelta>;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsProvider {
  readonly key: string;
  readonly label: string;
  readonly languages: string[];
  /** Voices available, for the dashboard's voice picker. */
  listVoices(language?: string): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  >;
  /**
   * Fed at CLAUSE boundaries, never per token — prosody depends on it
   * (docs/02 §The right way).
   */
  stream(opts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk>;
}

// ---------------------------------------------------------------------------

export type ProviderKind = 'stt' | 'llm' | 'tts';

export interface ProviderMeta {
  /** Rough per-minute cost, for the Cost Governor's estimates. */
  costPerMinuteUsd?: number;
  /** Measured time-to-first-byte, for provider selection. */
  typicalTtfbMs?: number;
  /** Where this provider may be used — a US vendor can't serve an EU-only workspace. */
  allowedBlocs?: Array<'US' | 'EU'>;
  selfHosted?: boolean;
}
