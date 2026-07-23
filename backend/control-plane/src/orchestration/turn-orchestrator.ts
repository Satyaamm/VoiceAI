/**
 * Turn orchestrator — the core loop. docs/02-call-flow.md.
 *
 * The whole design is in one sentence from docs/02: *"Yes as a chain of
 * components. No as a sequence of steps."* STT, the endpointer, the LLM and TTS
 * are always-running processes connected by queues; nothing here waits for a
 * previous stage to *finish*. Three overlaps do all the work:
 *
 *   1. STT overlaps the caller's speech      -> transcript already exists at commit
 *   2. LLM prefill overlaps the end of speech -> TTFT is 90ms warm, not 250ms cold
 *   3. TTS overlaps LLM decoding              -> speak word 3 while decoding word 40
 *
 * If you read this file top to bottom, read `listen()` and `respond()` as two
 * concurrent pipelines, not as two steps.
 *
 * Deliberately NOT in this file: audio encode/decode, AEC, VAD and the RTP playout
 * counter. Those live in the media node (Rust, docs/01 §3) because barge-in has to
 * stop audio in 20-30ms. Here they arrive as `AcousticFrame`s and `BargeInInput`s
 * over the `MediaSource` seam.
 */

import type { EventBus } from '../core/patterns/event-bus.js';
import type { HandlerChain } from '../core/patterns/chain.js';
import type { Logger } from '../core/patterns/factory.js';
import type {
  BargeInInput,
  BargeInStrategy,
  EndpointingInput,
  EndpointingStrategy,
} from '../core/patterns/strategy.js';
import type {
  AudioChunk,
  ChatMessage,
  LlmProvider,
  SttProvider,
  SttSession,
  ToolDefinition,
  TtsProvider,
} from '../providers/types.js';
import type { BaseEvent, PipelineEventName, PipelineEvents } from './events.js';
import { CallStateMachine, type CallState, type StateTransitionRecord } from './state-machine.js';
import { buildGuardrailChain, type GuardrailContext } from './guardrails.js';

// ---------------------------------------------------------------------------
// The media seam
// ---------------------------------------------------------------------------

/**
 * One ~20ms slice of the acoustic frontend's output (docs/01 §3). The media node
 * has already done de-jitter, AEC, denoise, VAD and the target-speaker check by
 * the time a frame reaches us.
 */
export interface AcousticFrame {
  /**
   * The media node's own clock, for cross-referencing its trace with ours. The
   * orchestrator timestamps frames on RECEIPT and uses that for the latency
   * numbers — two clocks in one measurement is how you get negative durations in
   * a waterfall.
   */
  readonly tMs: number;
  /** Is the caller speaking in this frame? */
  readonly speechActive: boolean;
  /** Milliseconds of silence since the last speech frame. */
  readonly silenceMs: number;
  /** Prosody features. Absent when the frontend can't compute them (v1 fallback). */
  readonly prosody?: EndpointingInput['prosody'];
  /** The audio itself, forwarded to STT. Optional: mocks script the transcript. */
  readonly audio?: AudioChunk;
}

/**
 * Everything the orchestrator needs from the media node. In production this is a
 * gRPC stream from the Rust media process on the same host; in the simulator it's
 * a scripted generator. The orchestrator cannot tell the difference, which is the
 * point — the eval harness exercises the real code path.
 */
export interface MediaSource {
  /** Is there another caller turn coming, or has the call run out? */
  hasTurn(turnIndex: number): boolean;
  /** ~20ms acoustic frames for a caller turn. Ends when the caller's turn is over. */
  frames(turnIndex: number): AsyncIterable<AcousticFrame>;
  /**
   * Polled during agent playout with the RTP playout counter. Returns the
   * barge-in feature vector when there is inbound energy, or null for silence.
   * `playoutMs` is passed back in so the strategy can weigh how far into the
   * utterance we are.
   */
  bargeInProbe(turnIndex: number, playoutMs: number): Omit<BargeInInput, 'playoutMs'> | null;
  /** What the dialogue engine expects next; widens/narrows the endpointer. */
  expectedSlot?(turnIndex: number): EndpointingInput['expectedSlot'];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolOutcome {
  readonly status: 'ok' | 'timeout' | 'error';
  readonly result: unknown;
}

export interface ToolRunner {
  run(call: ToolInvocation, signal: AbortSignal): Promise<unknown>;
  /**
   * Predicted p50 duration for this tool, from the latency table the Cost/Latency
   * governor keeps. > `fillerThresholdMs` fires the filler path (docs/02 §tool call).
   */
  predictMs(name: string): number;
  /** Spoken when the tool times out. A hung CRM must never hang a phone call. */
  fallbackUtterance(name: string): string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LatencyBreakdown {
  readonly turnIndex: number;
  /** Caller stopped speaking -> turn committed. The endpointer's cost. */
  readonly endpointingMs: number;
  /** Commit -> final transcript. ~0 with streaming STT; that's the whole point. */
  readonly sttFinalizeMs: number;
  /** Decode start -> first token. Speculative prefill is what shrinks this. */
  readonly llmTtftMs: number;
  /**
   * First token -> first audio out of TTS. Includes clause accumulation,
   * guardrails and normalization; the provider's own TTFB is on `tts.first_audio`.
   */
  readonly ttsTtfbMs: number;
  /** Encode + packetize + carrier hop. Constant from the media node's budget. */
  readonly networkMs: number;
  /** Sum of the five above == caller stopped speaking -> first audio in their ear. */
  readonly totalMs: number;
}

export interface CostRates {
  readonly sttUsdPerMinute: number;
  readonly llmUsdPerMillionInput: number;
  readonly llmUsdPerMillionOutput: number;
  readonly ttsUsdPerThousandChars: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  sttUsdPerMinute: 0.0043,
  llmUsdPerMillionInput: 0.15,
  llmUsdPerMillionOutput: 0.6,
  ttsUsdPerThousandChars: 0.03,
};

export interface CallConfig {
  readonly callId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly mode: 'test' | 'live';

  readonly language: string;
  readonly voiceId: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly greeting: string;
  /** Pre-rendered per agent per voice — zero synthesis cost (docs/02 §tool call). */
  readonly fillerText?: string;
  readonly repromptText?: string;

  readonly tools?: readonly ToolDefinition[];
  readonly groundingSpans?: readonly string[];

  /** Flush to TTS at punctuation, or after this many tokens. Never per token. */
  readonly clauseMinTokens?: number;
  /** Soft punctuation (`,` `;` `:`) only flushes past this many tokens. */
  readonly clauseSoftMinTokens?: number;
  /** Predicted tool duration above which the filler path fires. docs/02: 500ms. */
  readonly fillerThresholdMs?: number;
  /** Hard per-tool timeout. */
  readonly toolTimeoutMs?: number;
  /** Max LLM rounds per turn (each tool result costs a round). */
  readonly maxLlmRounds?: number;
  /** Silence in LISTENING after which we reprompt (docs/02 diagram: 6s). */
  readonly silenceTimeoutMs?: number;
  /** Encode + RTP + carrier, from docs/01 §1. Added to every turn's total. */
  readonly networkMs?: number;
  /**
   * Playout rate used to convert the RTP counter into *characters heard*, for the
   * barge-in truncation. Production reads byte-accurate marks from the media node;
   * this estimator only exists because a TTS chunk doesn't carry its own text.
   */
  readonly charsPerSecondSpoken?: number;
  readonly callerBaseline?: EndpointingInput['callerBaseline'];
  readonly costRates?: CostRates;
  readonly maxTurns?: number;
}

export interface OrchestratorDeps {
  readonly events: EventBus<PipelineEvents>;
  readonly stt: SttProvider;
  readonly llm: LlmProvider;
  readonly tts: TtsProvider;
  readonly endpointing: EndpointingStrategy;
  readonly bargeIn: BargeInStrategy;
  readonly media: MediaSource;
  readonly guardrails?: HandlerChain<string, GuardrailContext>;
  readonly toolRunner?: ToolRunner;
  readonly logger?: Logger;
  /** Injected clock; the simulator and tests own time. Milliseconds, monotonic. */
  readonly now?: () => number;
}

export interface CallResult {
  readonly callId: string;
  readonly turns: readonly LatencyBreakdown[];
  readonly messages: readonly ChatMessage[];
  readonly states: readonly StateTransitionRecord[];
  readonly durationMs: number;
  readonly endReason: string;
  readonly totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A unit of text handed to TTS. `inContext` is false for fillers and reprompts. */
interface Clause {
  readonly text: string;
  readonly inContext: boolean;
}

class BargeInSignal extends Error {
  constructor(readonly speechDurationMs: number) {
    super('barge-in');
    this.name = 'BargeInSignal';
  }
}

/** Minimal promise queue — the "ring buffer" between LLM decode and TTS playout. */
class ClauseQueue {
  private readonly items: Clause[] = [];
  private readonly waiters: Array<(v: Clause | null) => void> = [];
  private closed = false;

  push(item: Clause): void {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.(null);
  }

  next(): Promise<Clause | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Propagate a parent abort to a child controller and return an unsubscribe. */
function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) child.abort();
  const onAbort = () => child.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

/** Audio duration of a chunk. Float32 = samples; bytes assumed 16-bit PCM. */
function chunkDurationMs(chunk: AudioChunk): number {
  const samples =
    chunk.data instanceof Float32Array ? chunk.data.length : Math.floor(chunk.data.length / 2);
  return (samples / chunk.sampleRate) * 1000;
}

const TERMINAL_PUNCT = /[.!?…]["')\]]?\s*$/;
const SOFT_PUNCT = /[,;:—–-]["')\]]?\s*$/;

/**
 * Clause boundary detection (docs/01 §5 TTS, docs/02 t=2730).
 *
 * Terminal punctuation flushes immediately — that's a real prosodic boundary and
 * waiting past it makes the agent sound like it's reading. Soft punctuation needs
 * at least `softMin` tokens so we don't ship "Sure," as its own synthesis request
 * and get a clipped, breathy fragment. The token count is the backstop for models
 * that produce long unpunctuated runs.
 *
 * Never per token: a per-token TTS feed destroys prosody (the vocoder has no
 * lookahead) and multiplies request overhead by ~40x.
 */
export function isClauseBoundary(buffer: string, tokens: number, min: number, softMin: number): boolean {
  const t = buffer.trimEnd();
  if (!t) return false;
  if (TERMINAL_PUNCT.test(t)) return true;
  if (SOFT_PUNCT.test(t) && tokens >= softMin) return true;
  return tokens >= min;
}

/** Per-turn mutable bookkeeping. One instance per caller turn. */
interface TurnState {
  readonly turnIndex: number;
  /** Greeting / reprompt: audio, but not a caller turn — excluded from p50. */
  readonly standalone: boolean;
  readonly turnController: AbortController;
  ttsController: AbortController;

  // -- timeline (all ms since call start) --
  speechEndTMs: number;
  commitTMs: number;
  sttFinalTMs: number;
  decodeStartTMs: number;
  firstTokenTMs: number | null;
  firstAudioTMs: number | null;
  prefixCacheHit: boolean;

  // -- playout accounting (the barge-in bookkeeping) --
  /** Post-guardrail text handed to TTS that belongs in the assistant message. */
  spokenText: string;
  /** Characters of `spokenText` the caller has ACTUALLY heard. RTP counter proxy. */
  playedOutChars: number;
  /** Milliseconds of audio actually played out this turn. */
  playoutMs: number;
  /** Raw LLM output, before guardrails. Only used for the trace. */
  generatedText: string;

  bargeIn: { tMs: number; speechDurationMs: number } | null;
  blocked: { rule: string; reason: string } | null;
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number };
  ttsChars: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class TurnOrchestrator {
  private readonly startedAt: number;
  private readonly sm: CallStateMachine;
  private readonly guardrails: HandlerChain<string, GuardrailContext>;
  private readonly messages: ChatMessage[] = [];
  private readonly breakdowns: LatencyBreakdown[] = [];
  private readonly clock: () => number;
  /** Prefix-cache keys we've already touched, for the `prefixCacheHit` trace flag. */
  private readonly warmedCacheKeys = new Set<string>();
  private totalCostUsd = 0;
  private lastUserText = '';
  private endReason = 'completed';

  constructor(
    private readonly cfg: CallConfig,
    private readonly deps: OrchestratorDeps,
  ) {
    this.clock = deps.now ?? (() => performance.now());
    this.startedAt = this.clock();
    this.guardrails = deps.guardrails ?? buildGuardrailChain({
      onBudgetExceeded: (key, ms, budget) =>
        deps.logger?.warn('guardrail over budget', { key, ms, budget, callId: cfg.callId }),
    });
    this.sm = new CallStateMachine({
      callId: cfg.callId,
      initial: 'GREETING',
      now: () => this.tMs(),
    });
    this.messages.push({ role: 'system', content: cfg.systemPrompt });
  }

  get state(): CallState {
    return this.sm.state;
  }

  /** Milliseconds since call start — the `tMs` on every event. */
  private tMs(): number {
    return Math.round(this.clock() - this.startedAt);
  }

  private emit<K extends PipelineEventName>(
    type: K,
    payload: Omit<PipelineEvents[K], keyof BaseEvent>,
  ): void {
    this.deps.events.emit(type, {
      callId: this.cfg.callId,
      tMs: this.tMs(),
      ...payload,
    } as PipelineEvents[K]);
  }

  // -------------------------------------------------------------------------
  // Call
  // -------------------------------------------------------------------------

  async run(): Promise<CallResult> {
    this.emit('call.started', {
      agentId: this.cfg.agentId,
      workspaceId: this.cfg.workspaceId,
      direction: this.cfg.direction,
      mode: this.cfg.mode,
    });

    // GREETING. Barge-in applies here too: callers talk over greetings constantly.
    // If they did, `applyBargeInTruncation` has already walked us to LISTENING.
    await this.speakStandalone(-1, this.cfg.greeting, 'greeting');
    if (this.sm.state === 'GREETING') this.sm.fire('greeting_playout_done');

    const maxTurns = this.cfg.maxTurns ?? 32;
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
      if (!this.deps.media.hasTurn(turnIndex)) break;
      await this.runTurn(turnIndex);
      if (this.sm.state === 'ENDED') break;
    }

    const durationMs = this.tMs();
    if (this.sm.state !== 'ENDED') this.sm.fire('hangup');
    this.emit('call.ended', { reason: this.endReason, durationMs });

    return {
      callId: this.cfg.callId,
      turns: this.breakdowns,
      messages: this.messages,
      states: this.sm.history,
      durationMs,
      endReason: this.endReason,
      totalCostUsd: this.totalCostUsd,
    };
  }

  private async runTurn(turnIndex: number): Promise<void> {
    const listened = await this.listen(turnIndex);
    if (listened === null) return; // caller never spoke; HOLD/reprompt already handled

    const turn: TurnState = {
      turnIndex,
      standalone: false,
      turnController: new AbortController(),
      ttsController: new AbortController(),
      speechEndTMs: listened.speechEndTMs,
      commitTMs: listened.commitTMs,
      sttFinalTMs: listened.sttFinalTMs,
      decodeStartTMs: 0,
      firstTokenTMs: null,
      firstAudioTMs: null,
      prefixCacheHit: false,
      spokenText: '',
      playedOutChars: 0,
      playoutMs: 0,
      generatedText: '',
      bargeIn: null,
      blocked: null,
      usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      ttsChars: 0,
    };

    this.lastUserText = listened.transcript;
    this.messages.push({ role: 'user', content: listened.transcript });

    await this.respond(turn, listened.speculation);
    this.settleTurn(turn, listened);
  }

  // -------------------------------------------------------------------------
  // LISTEN — STT, endpointer and speculative prefill, all concurrent
  // -------------------------------------------------------------------------

  private async listen(turnIndex: number): Promise<ListenResult | null> {
    if (this.sm.state !== 'LISTENING') {
      // Every path into a caller turn (greeting done, playout complete, barge-in
      // truncated) lands in LISTENING. Anything else is a bug in the caller.
      this.deps.logger?.warn('listen from unexpected state', { state: this.sm.state });
    }

    const turnStartTMs = this.tMs();
    const sttController = new AbortController();
    const session: SttSession = await this.deps.stt.start({
      language: this.cfg.language,
      sampleRate: 16_000,
      expectedSlot: this.deps.media.expectedSlot?.(turnIndex),
      signal: sttController.signal,
    });

    // ---- STT runs CONCURRENTLY with the caller's speech (overlap #1). ----
    // We never "wait for the transcript"; by the time the endpointer commits, the
    // text is already here. This task is the reason sttFinalizeMs is ~0.
    let partial = '';
    let finalText: string | null = null;
    const finalArrived = deferred<number>();
    const sttPump = (async () => {
      for await (const t of session) {
        if (t.isFinal) {
          finalText = t.text;
          this.emit('stt.final', {
            text: t.text,
            confidence: t.confidence,
            durationMs: Math.max(0, this.tMs() - turnStartTMs),
          });
          finalArrived.resolve(this.tMs());
        } else {
          partial = t.text;
          this.emit('stt.partial', { text: t.text, confidence: t.confidence });
          this.sm.fireIfPossible('partial_transcript');
        }
      }
    })().catch((e) => this.deps.logger?.error('stt pump failed', { error: String(e) }));

    const baseline = this.cfg.callerBaseline ?? { meanPauseMs: 140, stdPauseMs: 60 };
    const expectedSlot = this.deps.media.expectedSlot?.(turnIndex);
    const silenceTimeout = this.cfg.silenceTimeoutMs ?? 6_000;

    let speculation: Speculation | null = null;
    let speechEndTMs = turnStartTMs;
    let sawSpeech = false;
    let speechEndEmitted = false;
    let commit: { tMs: number; probability: number; silenceMs: number } | null = null;

    for await (const frame of this.deps.media.frames(turnIndex)) {
      if (frame.audio) session.push(frame.audio);
      const frameTMs = this.tMs(); // our clock, not the media node's — see AcousticFrame

      if (frame.speechActive) {
        if (!sawSpeech) {
          sawSpeech = true;
          this.emit('vad.speech_start', {});
        }
        speechEndEmitted = false; // the caller resumed; there'll be another end
        speechEndTMs = frameTMs;
      } else if (sawSpeech && !speechEndEmitted) {
        speechEndEmitted = true;
        this.emit('vad.speech_end', {});
      }

      const decision = await this.deps.endpointing.decide({
        silenceMs: frame.silenceMs,
        partialTranscript: finalText ?? partial,
        prosody: frame.prosody,
        callerBaseline: baseline,
        expectedSlot,
      });
      this.emit('endpoint.score', {
        probability: decision.probability,
        reason: decision.reason,
      });

      if (decision.shouldCommit) {
        commit = {
          tMs: frameTMs,
          probability: decision.probability,
          silenceMs: frame.silenceMs,
        };
        break;
      }

      // ---- SPECULATIVE PREFILL (overlap #2, docs/02 t=2300) ----
      if (!speculation && decision.shouldSpeculate) {
        speculation = this.startSpeculativePrefill(finalText ?? partial, decision.probability);
      } else if (speculation && !decision.shouldSpeculate) {
        // The caller resumed: "my order number is four two seven—". P(done) fell
        // back below the speculate threshold, so the KV cache we're building is
        // for a prefix that is no longer the whole utterance.
        //
        // WHAT BREAKS WITHOUT THIS CANCEL: the speculative stream keeps decoding
        // in the background. When the caller finally stops, we commit and start a
        // second generation — so the GPU is now serving two decodes for one turn,
        // and at 100k concurrent calls that is not "8% extra prefill compute"
        // (docs/01 §5), it is a doubling of decode load that shows up as queueing
        // delay on *every other call in the batch*. Worse, if the stale stream is
        // still wired to the clause queue, the caller hears an answer to half a
        // sentence. Abort it, and say so in the trace.
        this.cancelSpeculation(speculation, 'speculation_discarded');
        speculation = null;
        this.sm.fireIfPossible('speculation_discarded');
      }

      // Reprompt path (diagram: Listening --> Reprompt: silence > 6s).
      if (!sawSpeech && frame.silenceMs >= silenceTimeout) {
        if (speculation) {
          this.cancelSpeculation(speculation, 'speculation_discarded');
          speculation = null;
        }
        session.end();
        sttController.abort();
        await sttPump;
        this.sm.fire('silence_timeout');
        await this.speakStandalone(
          turnIndex,
          this.cfg.repromptText ?? 'Are you still there?',
          'reprompt',
        );
        if (this.sm.state === 'HOLD') this.sm.fire('reprompt_played');
        return null;
      }
    }

    // ---- TURN COMMITTED. This timestamp is t=0 for latency measurement. ----
    const commitTMs = commit?.tMs ?? this.tMs();
    this.emit('endpoint.commit', {
      probability: commit?.probability ?? 1,
      silenceMs: commit?.silenceMs ?? 0,
    });
    this.sm.fire('turn_commit');

    // Stabilize the transcript. Streaming STT has already transcribed everything;
    // this is a mark-final, not a decode (docs/02 t=2595, "~0ms cost"). The race is
    // a safety net, not the expected path.
    session.end();
    let sttFinalTMs = commitTMs;
    if (finalText === null) {
      const won = await Promise.race([finalArrived.promise, sleep(120).then(() => null)]);
      sttFinalTMs = won ?? this.tMs();
    }
    sttController.abort();
    session.close();
    await sttPump;

    const transcript = (finalText ?? partial).trim();
    return {
      transcript,
      commitTMs,
      speechEndTMs,
      sttFinalTMs: Math.max(commitTMs, sttFinalTMs),
      speculation,
      speechDurationMs: Math.max(0, speechEndTMs - turnStartTMs),
    };
  }

  // -------------------------------------------------------------------------
  // Speculative prefill
  // -------------------------------------------------------------------------

  /**
   * Start building the KV cache for the current partial transcript, before the
   * caller has finished (docs/02 §2, docs/01 §5).
   *
   * This is a PREFILL, not a generation: we pull exactly one step off the stream so
   * the provider begins prefilling and warms the prefix cache keyed by agent id,
   * then discard whatever comes back. Committed decoding starts only after the
   * endpointer commits, on the *final* transcript. Cost is ~8% extra prefill
   * compute; the payoff is TTFT of ~90ms instead of ~250ms.
   */
  private startSpeculativePrefill(partial: string, probability: number): Speculation {
    const controller = new AbortController();
    const startedTMs = this.tMs();

    this.sm.fireIfPossible('speculate_threshold');
    this.emit('endpoint.speculate', { probability });
    this.emit('llm.prefill_start', { speculative: true });

    const task = (async () => {
      const stream = this.deps.llm.stream({
        model: this.cfg.model,
        messages: [...this.messages, { role: 'user', content: partial }],
        tools: this.cfg.tools ? [...this.cfg.tools] : undefined,
        cacheKey: this.cfg.agentId,
        signal: controller.signal,
      });
      const it = stream[Symbol.asyncIterator]();
      try {
        await it.next(); // begins prefill; result intentionally discarded
      } finally {
        // Release the provider's stream. Without this the generator is left
        // suspended and its connection/slot is held for the life of the call.
        await it.return?.(undefined as never);
      }
    })().catch(() => undefined); // aborted mid-prefill IS the discard path

    this.warmedCacheKeys.add(this.cfg.agentId);
    return { controller, task, startedTMs, partial };
  }

  private cancelSpeculation(spec: Speculation, reason: 'barge_in' | 'speculation_discarded'): void {
    spec.controller.abort();
    this.emit('llm.cancelled', { reason });
  }

  // -------------------------------------------------------------------------
  // RESPOND — LLM decode and TTS playout, concurrent (overlap #3)
  // -------------------------------------------------------------------------

  private async respond(turn: TurnState, speculation: Speculation | null): Promise<void> {
    // The speculation did its job the moment the prefix cache went warm. Abort the
    // stream (no `llm.cancelled` — it wasn't discarded, it was consumed) and start
    // the committed decode on the final transcript.
    speculation?.controller.abort();
    turn.prefixCacheHit = this.warmedCacheKeys.has(this.cfg.agentId);
    this.warmedCacheKeys.add(this.cfg.agentId);

    turn.decodeStartTMs = this.tMs();
    const queue = new ClauseQueue();

    // The queue IS the overlap: the producer below never waits for audio, and the
    // consumer never waits for the rest of the reply.
    const playout = this.playoutLoop(turn, queue);

    try {
      await this.decodeRounds(turn, queue);
    } finally {
      queue.close();
      await playout;
    }

    if (turn.bargeIn) {
      this.applyBargeInTruncation(turn);
      return;
    }

    const spoken = turn.spokenText.trim();
    if (spoken) this.messages.push({ role: 'assistant', content: spoken });
    // The floor goes back to the caller from wherever we ended up — including the
    // degenerate paths (empty reply, tool that produced no speech).
    this.sm.fireIfPossible('playout_complete');
  }

  /** LLM rounds: one per model turn. A tool result costs an extra round. */
  private async decodeRounds(turn: TurnState, queue: ClauseQueue): Promise<void> {
    const maxRounds = this.cfg.maxLlmRounds ?? 4;
    for (let round = 0; round < maxRounds; round++) {
      this.deps.logger?.debug('llm round', { callId: this.cfg.callId, round });
      const again = await this.decodeOnce(turn, queue);
      if (!again) return;
    }
    this.deps.logger?.warn('llm round cap hit', { callId: this.cfg.callId });
  }

  /** @returns true when a tool result was appended and another round is needed. */
  private async decodeOnce(turn: TurnState, queue: ClauseQueue): Promise<boolean> {
    const roundController = new AbortController();
    const unlink = linkAbort(turn.turnController.signal, roundController);

    this.emit('llm.prefill_start', { speculative: false });

    const clauseMin = this.cfg.clauseMinTokens ?? 8;
    const clauseSoftMin = this.cfg.clauseSoftMinTokens ?? 2;

    let buffer = '';
    let tokensInClause = 0;
    let pendingTool: ToolInvocation | null = null;

    try {
      for await (const delta of this.deps.llm.stream({
        model: this.cfg.model,
        messages: this.messages,
        tools: this.cfg.tools ? [...this.cfg.tools] : undefined,
        cacheKey: this.cfg.agentId,
        signal: roundController.signal,
      })) {
        if (roundController.signal.aborted) break;

        if (delta.type === 'text') {
          this.markFirstToken(turn);
          turn.generatedText += delta.text;
          buffer += delta.text;
          tokensInClause++;

          if (isClauseBoundary(buffer, tokensInClause, clauseMin, clauseSoftMin)) {
            const flushed = await this.flushClause(turn, queue, buffer);
            buffer = '';
            tokensInClause = 0;
            if (!flushed) return false; // guardrail blocked: stop generating
          }
          continue;
        }

        if (delta.type === 'tool_call') {
          // A tool call is still the model's first output — it stops the TTFT
          // clock, otherwise a tool turn reports a TTFT that includes the tool.
          this.markFirstToken(turn);
          pendingTool = { id: delta.id, name: delta.name, arguments: delta.arguments };
          break; // stop this round; the tool result changes the context
        }

        // done
        turn.usage = delta.usage;
        this.emit('llm.done', delta.usage);
      }
    } finally {
      unlink();
      roundController.abort();
    }

    if (buffer.trim() && !turn.bargeIn) {
      if (!(await this.flushClause(turn, queue, buffer))) return false;
    }
    if (!pendingTool || turn.bargeIn) return false;

    await this.runTool(turn, queue, pendingTool);
    return true;
  }

  private markFirstToken(turn: TurnState): void {
    if (turn.firstTokenTMs !== null) return;
    turn.firstTokenTMs = this.tMs();
    this.emit('llm.first_token', {
      ttftMs: turn.firstTokenTMs - turn.decodeStartTMs,
      prefixCacheHit: turn.prefixCacheHit,
    });
  }

  /**
   * Guardrails + normalization on one clause, then hand it to the playout queue.
   * @returns false when a guardrail blocked and generation must stop.
   */
  private async flushClause(turn: TurnState, queue: ClauseQueue, raw: string): Promise<boolean> {
    const ctx: GuardrailContext = {
      callId: this.cfg.callId,
      turnIndex: turn.turnIndex,
      userText: this.lastUserText,
      isFirstClause: turn.spokenText.length === 0,
      groundingSpans: this.cfg.groundingSpans ?? [],
      identityDisclosure: undefined,
    };

    const result = await this.guardrails.run(raw, ctx);
    for (const a of result.applied) {
      this.emit('guardrail.applied', { key: a.key, action: a.action, reason: a.reason });
    }
    const text = result.value.trim();
    if (text) queue.push({ text, inContext: true });

    if (result.blocked || result.escalated) {
      // One event per decision: the escalation reason wins when a handler set it,
      // because that's the one a compliance officer has to act on.
      turn.blocked = ctx.escalate ?? {
        rule: result.applied.at(-1)?.key ?? 'guardrail',
        reason: result.applied.at(-1)?.reason ?? 'blocked',
      };
      this.emit('compliance.blocked', { rule: turn.blocked.rule, reason: turn.blocked.reason });
      turn.turnController.abort(); // stop decoding; the reply is being replaced
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Tools — never block the loop (docs/02 §Branch: tool call)
  // -------------------------------------------------------------------------

  private async runTool(turn: TurnState, queue: ClauseQueue, call: ToolInvocation): Promise<void> {
    const runner = this.deps.toolRunner;
    this.sm.fireIfPossible('tool_call');
    this.emit('tool.started', { name: call.name, request: safeJson(call.arguments) });

    const startedTMs = this.tMs();
    const timeoutMs = this.cfg.toolTimeoutMs ?? 3_000;
    const toolController = new AbortController();
    const unlink = linkAbort(turn.turnController.signal, toolController);

    // Dispatched, NOT awaited. The next four statements run while the tool is in
    // flight — that is the whole point of the filler branch.
    const pending: Promise<ToolOutcome> = runner
      ? runner
          .run(call, toolController.signal)
          .then((result) => ({ status: 'ok' as const, result }))
          .catch((e) => ({ status: 'error' as const, result: String(e) }))
      : Promise.resolve({ status: 'error' as const, result: 'no tool runner configured' });

    const predictedMs = runner?.predictMs(call.name) ?? 0;
    const threshold = this.cfg.fillerThresholdMs ?? 500;
    if (predictedMs > threshold) {
      // Pre-rendered per agent per voice: zero synthesis cost, and the caller hears
      // something within the normal ~330ms instead of sitting in dead air for over
      // a second, which on a phone call reads as a dropped line (docs/02).
      this.sm.fireIfPossible('tool_slow');
      const filler = this.cfg.fillerText ?? 'Let me pull that up for you.';
      this.emit('filler.played', {
        text: filler,
        reason: `predicted ${Math.round(predictedMs)}ms > ${threshold}ms`,
      });
      // inContext:false — the filler is audio, not part of the assistant message.
      queue.push({ text: filler, inContext: false });
    }

    const outcome = await Promise.race<ToolOutcome>([
      pending,
      sleep(timeoutMs).then(() => ({ status: 'timeout' as const, result: null })),
    ]);
    unlink();
    if (outcome.status === 'timeout') toolController.abort();

    const durationMs = this.tMs() - startedTMs;
    this.emit('tool.finished', {
      name: call.name,
      durationMs,
      status: outcome.status,
      response: outcome.result,
    });

    // Validated before it enters context — a tool is untrusted input like any
    // other (docs/02 §tool rules, docs/03 §E injection defense).
    const content =
      outcome.status === 'ok'
        ? JSON.stringify(outcome.result ?? null)
        : JSON.stringify({
            error: outcome.status,
            say: runner?.fallbackUtterance(call.name) ?? 'I could not reach that system.',
          });

    this.messages.push({
      role: 'assistant',
      content: '',
      toolCallId: call.id,
      name: call.name,
    });
    this.messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });
  }

  // -------------------------------------------------------------------------
  // PLAYOUT — TTS + the playout counter that barge-in truncation depends on
  // -------------------------------------------------------------------------

  private async playoutLoop(turn: TurnState, queue: ClauseQueue): Promise<void> {
    for (;;) {
      const clause = await queue.next();
      if (!clause) return;
      if (turn.bargeIn) return;
      try {
        await this.playClause(turn, clause);
      } catch (e) {
        if (e instanceof BargeInSignal) {
          turn.bargeIn = { tMs: this.tMs(), speechDurationMs: e.speechDurationMs };
          return;
        }
        throw e;
      }
    }
  }

  private async playClause(turn: TurnState, clause: Clause): Promise<void> {
    const flushStartTMs = this.tMs();
    const charsBefore = turn.spokenText.length;
    if (clause.inContext) turn.spokenText += (charsBefore ? ' ' : '') + clause.text;
    turn.ttsChars += clause.text.length;

    const charsPerMs = (this.cfg.charsPerSecondSpoken ?? 1000 / 6) / 1000;
    let clausePlayoutMs = 0;
    let first = true;

    for await (const chunk of this.deps.tts.stream({
      text: clause.text,
      voiceId: this.cfg.voiceId,
      language: this.cfg.language,
      signal: turn.ttsController.signal,
    })) {
      if (turn.ttsController.signal.aborted) break;

      if (first) {
        first = false;
        this.emit('tts.first_audio', { ttfbMs: this.tMs() - flushStartTMs });
        this.sm.fireIfPossible('first_clause'); // THINKING/TOOL_CALL/FILLER -> SPEAKING
        if (turn.firstAudioTMs === null) {
          turn.firstAudioTMs = this.tMs();
          // A greeting has no endpointing/LLM legs; measuring it as a turn would
          // drag the p50 the product is sold on downwards for free.
          if (!turn.standalone) this.emitTurnCompleted(turn);
        }
      }

      const ms = chunkDurationMs(chunk);
      clausePlayoutMs += ms;
      turn.playoutMs += ms;
      if (clause.inContext) {
        // The RTP playout counter, converted to characters. Production reads a
        // byte-accurate mark from the media node; here we integrate the speaking
        // rate. Monotonic and clamped to the clause so it can never over-count.
        turn.playedOutChars = Math.min(
          charsBefore + clause.text.length + (charsBefore ? 1 : 0),
          Math.max(
            turn.playedOutChars,
            charsBefore + Math.round(clausePlayoutMs * charsPerMs),
          ),
        );
      }

      // ---- BARGE-IN probe, once per chunk of real audio ----
      const probe = this.deps.media.bargeInProbe(turn.turnIndex, turn.playoutMs);
      if (probe) {
        const decision = await this.deps.bargeIn.decide({ ...probe, playoutMs: turn.playoutMs });
        if (decision.yield) {
          throw new BargeInSignal(probe.speechDurationMs);
        }
        // Rejections are the interesting half: a TV in the background or an "mhm"
        // must NOT stop the agent. Traced so the tuning is auditable (docs/03 §A).
        this.emit('bargein.rejected', { reason: decision.reason });
      }
    }

    if (!turn.ttsController.signal.aborted) {
      // Clause finished cleanly: every character of it was heard.
      if (clause.inContext) turn.playedOutChars = turn.spokenText.length;
      this.emit('tts.done', { durationMs: Math.round(clausePlayoutMs) });
    }
  }

  /** Greeting / reprompt / filler played outside a caller turn's accounting. */
  private async speakStandalone(
    turnIndex: number,
    text: string,
    kind: 'greeting' | 'reprompt',
  ): Promise<void> {
    const turn: TurnState = {
      turnIndex,
      standalone: true,
      turnController: new AbortController(),
      ttsController: new AbortController(),
      speechEndTMs: 0,
      commitTMs: 0,
      sttFinalTMs: 0,
      decodeStartTMs: 0,
      firstTokenTMs: null,
      firstAudioTMs: null,
      prefixCacheHit: false,
      spokenText: '',
      playedOutChars: 0,
      playoutMs: 0,
      generatedText: text,
      bargeIn: null,
      blocked: null,
      usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      ttsChars: 0,
    };
    try {
      await this.playClause(turn, { text, inContext: true });
    } catch (e) {
      if (!(e instanceof BargeInSignal)) throw e;
      turn.bargeIn = { tMs: this.tMs(), speechDurationMs: e.speechDurationMs };
      this.applyBargeInTruncation(turn);
      return;
    }
    if (kind === 'greeting') {
      this.messages.push({ role: 'assistant', content: text });
    }
  }

  // -------------------------------------------------------------------------
  // BARGE-IN bookkeeping — docs/02 §Branch: barge-in, step t=5130
  // -------------------------------------------------------------------------

  /**
   * THE step everyone gets wrong.
   *
   * The caller interrupted. We killed TTS and cancelled the LLM. The assistant
   * message now in flight contains everything the model *generated* — but the
   * caller only heard what the RTP counter actually played out. Those two numbers
   * are different by design, because TTS runs ahead of the ear and the LLM runs
   * ahead of TTS.
   *
   * WHAT BREAKS WITHOUT THIS TRUNCATION: the context says the agent already gave
   * the order number, the shipping date and the return policy. The caller heard
   * "Okay, order four two—". On the next turn the model, quite correctly, does not
   * repeat itself: "as I said, it arrives Thursday." The caller has no idea what
   * it's talking about, and every subsequent turn is built on a transcript that
   * never happened. This is the root cause of "the agent forgot what it was saying
   * after I interrupted" — a bookkeeping bug, not a model quality problem, and no
   * amount of prompt engineering fixes it.
   *
   * So: truncate to exactly `playedOutChars`, emit both numbers, and let the trace
   * viewer show the gap.
   */
  private applyBargeInTruncation(turn: TurnState): void {
    // 1. Stop making audio and stop making tokens. Order matters: audio first,
    //    because that is what the caller is talking over.
    turn.ttsController.abort();
    turn.turnController.abort();

    this.sm.fireIfPossible('barge_in_confirmed');
    this.emit('bargein.detected', { speechDurationMs: turn.bargeIn?.speechDurationMs ?? 0 });
    this.emit('tts.cancelled', { playedOutMs: Math.round(turn.playoutMs) });
    this.emit('llm.cancelled', { reason: 'barge_in' });

    // 2. Read the playout counter and cut the assistant message to it.
    const generated = turn.spokenText;
    const played = Math.max(0, Math.min(turn.playedOutChars, generated.length));
    const heard = generated.slice(0, played).trimEnd();

    this.emit('bargein.truncated', {
      playedOutChars: heard.length,
      generatedChars: turn.generatedText.length || generated.length,
    });

    // 3. Only what was heard enters the context. Ellipsis marks the cut so the
    //    model knows it was interrupted rather than that it chose to stop.
    if (heard) {
      this.messages.push({ role: 'assistant', content: `${heard}—` });
    }

    // 4. Back to LISTENING. STT is already transcribing the interruption.
    if (this.sm.state === 'BARGE_IN') this.sm.fire('context_truncated');
  }

  // -------------------------------------------------------------------------
  // Latency + cost
  // -------------------------------------------------------------------------

  /**
   * Emitted the instant the first audio of a turn leaves for the caller's ear.
   *
   * The five components sum exactly to `totalMs` so the dashboard's waterfall has
   * no unexplained gap — every millisecond between "caller stopped speaking" and
   * "caller heard something" is attributed to a stage that someone owns.
   */
  private emitTurnCompleted(turn: TurnState): void {
    const firstAudio = turn.firstAudioTMs ?? this.tMs();
    const networkMs = this.cfg.networkMs ?? 60;

    const endpointingMs = Math.max(0, turn.commitTMs - turn.speechEndTMs);
    const sttFinalizeMs = Math.max(0, turn.sttFinalTMs - turn.commitTMs);
    const llmTtftMs = Math.max(0, (turn.firstTokenTMs ?? firstAudio) - turn.decodeStartTMs);
    // Everything between first token and first audio: clause accumulation,
    // guardrails, normalization, TTS TTFB. The provider's raw TTFB is on the
    // `tts.first_audio` event if you need to separate them.
    const ttsTtfbMs = Math.max(0, firstAudio - (turn.firstTokenTMs ?? firstAudio));

    const breakdown: LatencyBreakdown = {
      turnIndex: turn.turnIndex,
      endpointingMs,
      sttFinalizeMs,
      llmTtftMs,
      ttsTtfbMs,
      networkMs,
      totalMs: endpointingMs + sttFinalizeMs + llmTtftMs + ttsTtfbMs + networkMs,
    };
    this.breakdowns.push(breakdown);
    this.emit('turn.completed', breakdown);
  }

  private settleTurn(turn: TurnState, listened: ListenResult): void {
    const rates = this.cfg.costRates ?? DEFAULT_COST_RATES;
    const turnCost =
      (listened.speechDurationMs / 60_000) * rates.sttUsdPerMinute +
      ((turn.usage.promptTokens - turn.usage.cachedTokens) / 1e6) * rates.llmUsdPerMillionInput +
      (turn.usage.completionTokens / 1e6) * rates.llmUsdPerMillionOutput +
      (turn.ttsChars / 1000) * rates.ttsUsdPerThousandChars;
    this.totalCostUsd += turnCost;

    this.emit('cost.updated', {
      totalUsd: round6(this.totalCostUsd),
      breakdown: {
        stt: round6((listened.speechDurationMs / 60_000) * rates.sttUsdPerMinute),
        llm: round6(
          ((turn.usage.promptTokens - turn.usage.cachedTokens) / 1e6) *
            rates.llmUsdPerMillionInput +
            (turn.usage.completionTokens / 1e6) * rates.llmUsdPerMillionOutput,
        ),
        tts: round6((turn.ttsChars / 1000) * rates.ttsUsdPerThousandChars),
      },
    });
  }
}

// ---------------------------------------------------------------------------

interface Speculation {
  readonly controller: AbortController;
  readonly task: Promise<void>;
  readonly startedTMs: number;
  readonly partial: string;
}

interface ListenResult {
  readonly transcript: string;
  readonly commitTMs: number;
  readonly speechEndTMs: number;
  readonly sttFinalTMs: number;
  readonly speculation: Speculation | null;
  readonly speechDurationMs: number;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
