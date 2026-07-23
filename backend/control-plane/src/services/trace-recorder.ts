/**
 * Trace recorder — the bridge from live pipeline events to the dashboard's
 * waterfall (docs/07 §call trace viewer).
 *
 * It subscribes to the EventBus and folds the flat event stream into the turn
 * structure the viewer renders. Everything here runs on the SYNC listener path, so
 * every handler is an append to an in-memory buffer and nothing else — a recorder
 * that allocates or awaits would add latency to a live phone call
 * (see `core/patterns/event-bus.ts`).
 *
 * Persistence is deliberately NOT done here. Repositories require a
 * `WorkspaceScope`, and the pipeline has no request principal to derive one from,
 * so the recorder emits a finalized payload through `onFinalized` and the wiring
 * layer — which does hold a scope — writes it via `CallService.ingest`. That keeps
 * the "no unscoped write" rule intact instead of punching a hole in it.
 */

import type { EventBus } from '../core/patterns/event-bus.js';
import type { PipelineEvents } from '../orchestration/events.js';
import type {
  Call,
  CallTrace,
  LatencyBreakdown,
  TraceEvent,
  TraceToolCall,
  Turn,
} from '../domain/call-schemas.js';

/** Waveform resolution. 100ms bins keep a 10-minute call at 6k points per lane. */
const WAVEFORM_BIN_MS = 100;

export function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function medianOf(values: readonly number[]): number {
  return percentileOf(values, 50);
}

/**
 * What the recorder knows when a call ends. Everything else on a `Call` — the
 * agent's name, the phone numbers, the agent version — belongs to whoever placed
 * the call, not to the pipeline.
 */
export interface FinalizedTrace {
  callId: string;
  workspaceId: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  mode: 'test' | 'live';
  durationMs: number;
  endReason: string;
  turns: Turn[];
  events: TraceEvent[];
  waveform: CallTrace['waveform'];
  metrics: {
    turnCount: number;
    medianLatencyMs: number;
    p95LatencyMs: number;
    bargeInCount: number;
    costUsd: number;
  };
  complianceFlags: string[];
}

interface OpenCallerTurn {
  startMs: number;
  transcript: string;
}

interface OpenAgentTurn {
  startMs: number;
  toolCalls: TraceToolCall[];
  guardrails: Array<{ key: string; action: string; reason: string }>;
  interrupted: boolean;
  playedOutChars: number | undefined;
  generatedChars: number | undefined;
}

interface Assembly {
  callId: string;
  workspaceId: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  mode: 'test' | 'live';
  events: TraceEvent[];
  turns: Turn[];
  openCaller: OpenCallerTurn | null;
  openAgent: OpenAgentTurn | null;
  /** Held between `turn.completed` and the agent turn closing. */
  pendingLatency: Omit<
    LatencyBreakdown,
    'prefixCacheHit' | 'promptTokens' | 'cachedTokens' | 'completionTokens'
  > | null;
  prefixCacheHit: boolean;
  tokens: { promptTokens: number; cachedTokens: number; completionTokens: number };
  openTools: Map<string, { startMs: number; request: unknown }>;
  callerSpans: Array<[number, number]>;
  agentSpans: Array<[number, number]>;
  lastTMs: number;
  bargeInCount: number;
  costUsd: number;
  complianceFlags: string[];
}

export interface TraceRecorderOptions {
  /** Guards against a leaked call id pinning a buffer forever. */
  maxOpenCalls?: number;
}

export class TraceRecorder {
  private readonly open = new Map<string, Assembly>();
  private readonly finalizedHandlers = new Set<(trace: FinalizedTrace) => void>();
  private readonly unsubscribes: Array<() => void> = [];
  private readonly maxOpenCalls: number;

  constructor(
    private readonly bus: EventBus<PipelineEvents>,
    opts: TraceRecorderOptions = {},
  ) {
    this.maxOpenCalls = opts.maxOpenCalls ?? 10_000;
  }

  /** Wire up every subscription. Returns a detach function for tests. */
  attach(): () => void {
    const on = <K extends keyof PipelineEvents>(
      type: K,
      handler: (payload: PipelineEvents[K], a: Assembly) => void,
    ) => {
      this.unsubscribes.push(
        this.bus.on(type, (payload) => {
          const base = payload as { callId: string; tMs: number };
          const assembly = this.open.get(base.callId);
          // A call whose `call.started` we never saw is not traceable — dropping it
          // is correct, and quieter than half-assembling it.
          if (!assembly) return;
          assembly.lastTMs = Math.max(assembly.lastTMs, base.tMs);
          handler(payload, assembly);
        }),
      );
    };

    this.unsubscribes.push(
      this.bus.on('call.started', (e) => {
        if (this.open.size >= this.maxOpenCalls) return;
        this.open.set(e.callId, {
          callId: e.callId,
          workspaceId: e.workspaceId,
          agentId: e.agentId,
          direction: e.direction,
          mode: e.mode,
          events: [],
          turns: [],
          openCaller: null,
          openAgent: null,
          pendingLatency: null,
          prefixCacheHit: false,
          tokens: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
          openTools: new Map(),
          callerSpans: [],
          agentSpans: [],
          lastTMs: e.tMs,
          bargeInCount: 0,
          costUsd: 0,
          complianceFlags: [],
        });
      }),
    );

    // -- Caller side -------------------------------------------------------
    on('vad.speech_start', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'vad', type: 'speech_start' });
      a.callerSpans.push([e.tMs, e.tMs]);
      a.openCaller ??= { startMs: e.tMs, transcript: '' };
    });

    on('vad.speech_end', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'vad', type: 'speech_end' });
      const span = a.callerSpans[a.callerSpans.length - 1];
      if (span) span[1] = e.tMs;
    });

    on('endpoint.score', (e, a) => {
      // The P(done) curve. Sampled every ~20ms upstream; the viewer downsamples to
      // the viewport, so we keep every point.
      a.events.push({ tMs: e.tMs, lane: 'endpoint', type: 'score', value: e.probability, text: e.reason });
    });

    on('endpoint.speculate', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'llm', type: 'speculate', value: e.probability });
    });

    on('endpoint.commit', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'endpoint', type: 'commit', value: e.probability });
      this.closeCallerTurn(a, e.tMs);
    });

    on('stt.partial', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'stt', type: 'partial', value: e.confidence, text: e.text });
    });

    on('stt.final', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'stt', type: 'final', value: e.confidence, text: e.text });
      a.openCaller ??= { startMs: e.tMs, transcript: '' };
      a.openCaller.transcript = a.openCaller.transcript
        ? `${a.openCaller.transcript} ${e.text}`
        : e.text;
    });

    // -- Agent side --------------------------------------------------------
    on('llm.prefill_start', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'llm', type: e.speculative ? 'prefill_speculative' : 'prefill' });
    });

    on('llm.first_token', (e, a) => {
      a.prefixCacheHit = e.prefixCacheHit;
      a.events.push({ tMs: e.tMs, lane: 'llm', type: 'first_token', value: e.ttftMs });
    });

    on('llm.done', (e, a) => {
      a.tokens = {
        promptTokens: e.promptTokens,
        cachedTokens: e.cachedTokens,
        completionTokens: e.completionTokens,
      };
      a.events.push({ tMs: e.tMs, lane: 'llm', type: 'done', value: e.completionTokens });
    });

    on('llm.cancelled', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'llm', type: 'cancelled', text: e.reason });
    });

    on('tts.first_audio', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'tts', type: 'first_audio', value: e.ttfbMs });
      this.openAgentTurn(a, e.tMs);
    });

    on('tts.done', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'tts', type: 'done', value: e.durationMs });
      this.closeAgentTurn(a, e.tMs);
    });

    on('tts.cancelled', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'tts', type: 'cancelled', value: e.playedOutMs });
      this.closeAgentTurn(a, e.tMs);
    });

    // -- Tools -------------------------------------------------------------
    on('tool.started', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'tool', type: 'started', text: e.name });
      a.openTools.set(e.name, { startMs: e.tMs, request: e.request });
    });

    on('tool.finished', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'tool', type: e.status, value: e.durationMs, text: e.name });
      const started = a.openTools.get(e.name);
      a.openTools.delete(e.name);
      this.openAgentTurn(a, started?.startMs ?? e.tMs).toolCalls.push({
        name: e.name,
        startMs: started?.startMs ?? Math.max(0, e.tMs - e.durationMs),
        durationMs: e.durationMs,
        status: e.status,
        request: started?.request,
        response: e.response,
      });
    });

    on('filler.played', (e, a) => {
      // Rendered on the tool lane because a filler only ever exists because a tool
      // was slow (docs/02 §tool call).
      a.events.push({ tMs: e.tMs, lane: 'tool', type: 'filler', text: e.text });
      this.openAgentTurn(a, e.tMs);
      a.agentSpans.push([e.tMs, e.tMs]);
    });

    // -- Guardrails and barge-in -------------------------------------------
    on('guardrail.applied', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'guardrail', type: e.action, text: `${e.key}: ${e.reason}` });
      this.openAgentTurn(a, e.tMs).guardrails.push({ key: e.key, action: e.action, reason: e.reason });
    });

    on('bargein.detected', (e, a) => {
      a.bargeInCount += 1;
      a.events.push({ tMs: e.tMs, lane: 'bargein', type: 'detected', value: e.speechDurationMs });
      if (a.openAgent) a.openAgent.interrupted = true;
    });

    on('bargein.rejected', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'bargein', type: 'rejected', text: e.reason });
    });

    on('bargein.truncated', (e, a) => {
      // docs/02 §barge-in: this pair is the bookkeeping the viewer surfaces —
      // generated vs. actually heard.
      a.events.push({ tMs: e.tMs, lane: 'bargein', type: 'truncated', value: e.playedOutChars });
      const agent = this.openAgentTurn(a, e.tMs);
      agent.interrupted = true;
      agent.playedOutChars = e.playedOutChars;
      agent.generatedChars = e.generatedChars;
    });

    // -- Turn metrics and lifecycle ----------------------------------------
    on('turn.completed', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'endpoint', type: 'turn_completed', value: e.totalMs });
      a.pendingLatency = {
        totalMs: e.totalMs,
        endpointingMs: e.endpointingMs,
        sttFinalizeMs: e.sttFinalizeMs,
        llmTtftMs: e.llmTtftMs,
        ttsTtfbMs: e.ttsTtfbMs,
        networkMs: e.networkMs,
      };
    });

    on('compliance.blocked', (e, a) => {
      a.events.push({ tMs: e.tMs, lane: 'guardrail', type: 'compliance_blocked', text: `${e.rule}: ${e.reason}` });
      a.complianceFlags.push(e.rule);
    });

    on('cost.updated', (e, a) => {
      a.costUsd = e.totalUsd;
    });

    on('call.ended', (e, a) => {
      this.closeCallerTurn(a, e.tMs);
      this.closeAgentTurn(a, e.tMs);
      this.open.delete(a.callId);
      const finalized = this.finalize(a, e.durationMs, e.reason);
      for (const h of this.finalizedHandlers) {
        try {
          h(finalized);
        } catch {
          // A failing persistence hook must not take down the turn loop.
        }
      }
    });

    return () => this.detach();
  }

  detach(): void {
    for (const un of this.unsubscribes) un();
    this.unsubscribes.length = 0;
  }

  onFinalized(handler: (trace: FinalizedTrace) => void): () => void {
    this.finalizedHandlers.add(handler);
    return () => this.finalizedHandlers.delete(handler);
  }

  /**
   * Trace for a call still in progress — what the live-call detail screen renders.
   * The `Call` row is supplied by the caller because tenancy and identity live
   * there, not in the event stream.
   */
  snapshot(call: Call): CallTrace | null {
    const a = this.open.get(call.id);
    if (!a) return null;
    const turns = [...a.turns];
    return {
      call,
      turns,
      events: [...a.events],
      waveform: buildWaveform(a.callerSpans, a.agentSpans, a.lastTMs),
    };
  }

  // -------------------------------------------------------------------------

  private closeCallerTurn(a: Assembly, tMs: number): void {
    const open = a.openCaller;
    if (!open) return;
    a.openCaller = null;
    a.turns.push({
      index: a.turns.length,
      role: 'caller',
      transcript: open.transcript,
      startMs: open.startMs,
      endMs: Math.max(open.startMs, tMs),
    });
  }

  private openAgentTurn(a: Assembly, tMs: number): OpenAgentTurn {
    if (!a.openAgent) {
      a.openAgent = {
        startMs: tMs,
        toolCalls: [],
        guardrails: [],
        interrupted: false,
        playedOutChars: undefined,
        generatedChars: undefined,
      };
      a.agentSpans.push([tMs, tMs]);
    }
    return a.openAgent;
  }

  private closeAgentTurn(a: Assembly, tMs: number): void {
    const open = a.openAgent;
    if (!open) return;
    a.openAgent = null;

    const span = a.agentSpans[a.agentSpans.length - 1];
    if (span) span[1] = Math.max(span[1], tMs);

    const turn: Turn = {
      index: a.turns.length,
      role: 'agent',
      // The event schema carries no agent-text event, so the spoken text is filled
      // in by the orchestrator's own transcript write. See the module note.
      transcript: '',
      startMs: open.startMs,
      endMs: Math.max(open.startMs, tMs),
    };
    if (a.pendingLatency) {
      turn.latency = {
        ...a.pendingLatency,
        prefixCacheHit: a.prefixCacheHit,
        ...a.tokens,
      };
      a.pendingLatency = null;
    }
    if (open.interrupted) turn.interrupted = true;
    if (open.playedOutChars !== undefined) turn.playedOutChars = open.playedOutChars;
    if (open.toolCalls.length) turn.toolCalls = open.toolCalls;
    if (open.guardrails.length) turn.guardrails = open.guardrails;
    a.turns.push(turn);
  }

  private finalize(a: Assembly, durationMs: number, reason: string): FinalizedTrace {
    const latencies = a.turns.flatMap((t) => (t.latency ? [t.latency.totalMs] : []));
    return {
      callId: a.callId,
      workspaceId: a.workspaceId,
      agentId: a.agentId,
      direction: a.direction,
      mode: a.mode,
      durationMs,
      endReason: reason,
      turns: a.turns,
      events: a.events,
      waveform: buildWaveform(a.callerSpans, a.agentSpans, Math.max(durationMs, a.lastTMs)),
      metrics: {
        turnCount: a.turns.length,
        medianLatencyMs: Math.round(medianOf(latencies)),
        p95LatencyMs: Math.round(percentileOf(latencies, 95)),
        bargeInCount: a.bargeInCount,
        costUsd: a.costUsd,
      },
      complianceFlags: a.complianceFlags,
    };
  }
}

/**
 * Speech-activity envelope, not an amplitude envelope: the event stream carries VAD
 * spans, not sample energy. Real per-bin amplitude arrives from the media node's
 * recording tap (docs/01 §3) and replaces this without changing the shape.
 */
function buildWaveform(
  callerSpans: ReadonlyArray<readonly [number, number]>,
  agentSpans: ReadonlyArray<readonly [number, number]>,
  durationMs: number,
): CallTrace['waveform'] {
  const bins = Math.max(1, Math.ceil(durationMs / WAVEFORM_BIN_MS));
  const lane = (spans: ReadonlyArray<readonly [number, number]>): number[] => {
    const out = new Array<number>(bins).fill(0);
    for (const [start, end] of spans) {
      const from = Math.max(0, Math.floor(start / WAVEFORM_BIN_MS));
      const to = Math.min(bins - 1, Math.floor(end / WAVEFORM_BIN_MS));
      for (let i = from; i <= to; i += 1) out[i] = 0.8;
    }
    return out;
  };
  return { caller: lane(callerSpans), agent: lane(agentSpans), binMs: WAVEFORM_BIN_MS };
}
