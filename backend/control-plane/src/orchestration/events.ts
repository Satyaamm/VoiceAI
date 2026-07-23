/**
 * Pipeline event schema.
 *
 * Every stage of a turn emits one of these. Two consumers: the trace recorder
 * (which builds the waterfall the dashboard renders) and the async plane
 * (analytics, billing, webhooks).
 *
 * `tMs` is always relative to call start, so the dashboard can align every lane
 * on one timeline without server-side clock reconciliation.
 */

export interface BaseEvent {
  callId: string;
  /** Milliseconds since call start. */
  tMs: number;
}

export interface PipelineEvents extends Record<string, unknown> {
  'call.started': BaseEvent & {
    agentId: string;
    workspaceId: string;
    direction: 'inbound' | 'outbound';
    mode: 'test' | 'live';
  };
  'call.ended': BaseEvent & { reason: string; durationMs: number };

  'vad.speech_start': BaseEvent;
  'vad.speech_end': BaseEvent;

  /** Emitted every ~20ms during a caller turn — the P(done) curve in the trace. */
  'endpoint.score': BaseEvent & { probability: number; reason: string };
  /** P(done) crossed the speculate threshold; LLM prefill starts. */
  'endpoint.speculate': BaseEvent & { probability: number };
  /** Turn committed. This timestamp is t=0 for the latency measurement. */
  'endpoint.commit': BaseEvent & { probability: number; silenceMs: number };

  'stt.partial': BaseEvent & { text: string; confidence: number };
  'stt.final': BaseEvent & { text: string; confidence: number; durationMs: number };

  'llm.prefill_start': BaseEvent & { speculative: boolean };
  'llm.first_token': BaseEvent & { ttftMs: number; prefixCacheHit: boolean };
  /**
   * The agent's generated text for this turn, post-guardrails, pre-TTS.
   *
   * Added because the trace recorder had no way to reconstruct what the agent
   * actually SAID — token counts and timings alone can't populate a transcript.
   * Emitted once per turn at generation end, not per token.
   */
  'llm.text': BaseEvent & { turnIndex: number; text: string };
  'llm.done': BaseEvent & {
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
  };
  'llm.cancelled': BaseEvent & { reason: 'barge_in' | 'speculation_discarded' };

  'tts.first_audio': BaseEvent & { ttfbMs: number };
  'tts.done': BaseEvent & { durationMs: number };
  /**
   * `playedOutText` is the authoritative record of what the caller actually HEARD.
   * docs/02 §barge-in: context must be truncated to exactly this, not to what was
   * generated. The trace viewer renders the difference.
   */
  'tts.cancelled': BaseEvent & { playedOutMs: number; playedOutText?: string };

  'tool.started': BaseEvent & { name: string; request: unknown };
  'tool.finished': BaseEvent & {
    name: string;
    durationMs: number;
    status: 'ok' | 'timeout' | 'error';
    response: unknown;
  };
  'filler.played': BaseEvent & { text: string; reason: string };

  'guardrail.applied': BaseEvent & { key: string; action: string; reason: string };

  'bargein.detected': BaseEvent & { speechDurationMs: number };
  'bargein.rejected': BaseEvent & { reason: string };
  /**
   * The bookkeeping that everyone gets wrong (docs/02 §barge-in): context is
   * truncated to exactly what the caller actually heard.
   */
  'bargein.truncated': BaseEvent & { playedOutChars: number; generatedChars: number };

  /** end-of-speech -> first audio out. The number the product is sold on. */
  'turn.completed': BaseEvent & {
    turnIndex: number;
    totalMs: number;
    endpointingMs: number;
    sttFinalizeMs: number;
    llmTtftMs: number;
    ttsTtfbMs: number;
    networkMs: number;
  };

  'compliance.blocked': BaseEvent & { rule: string; reason: string };
  'cost.updated': BaseEvent & { totalUsd: number; breakdown: Record<string, number> };
}

export type PipelineEventName = keyof PipelineEvents;
