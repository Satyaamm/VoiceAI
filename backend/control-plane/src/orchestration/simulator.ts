/**
 * Call simulator — drives a full synthetic call through the real orchestrator.
 *
 * This is not a test double for the orchestrator; it is a test double for the
 * *world*. The orchestrator, state machine and guardrails under here are the exact
 * code that runs on a live call. Only the media node and the three providers are
 * scripted, through the `MediaSource` seam and the mock providers.
 *
 * Two consumers:
 *   - the eval harness (regression on p50/p95 and on turn-taking correctness)
 *   - the dashboard's trace fixtures (a waterfall that looks like production,
 *     because the timings in mock.ts mirror the budget in docs/01 §1)
 *
 * Everything is deterministic apart from real wall-clock jitter, so a p50 that
 * moves means the pipeline moved.
 */

import { EventBus } from '../core/patterns/event-bus.js';
import {
  SemanticEndpointing,
  TargetSpeakerBargeIn,
  type BargeInInput,
  type BargeInStrategy,
  type EndpointingInput,
  type EndpointingStrategy,
} from '../core/patterns/strategy.js';
import { MockLlmProvider, MockSttProvider, MockTtsProvider } from '../providers/mock.js';
import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../providers/types.js';
import type { PipelineEventName, PipelineEvents } from './events.js';
import { buildGuardrailChain } from './guardrails.js';
import type { StateTransitionRecord } from './state-machine.js';
import {
  TurnOrchestrator,
  type AcousticFrame,
  type CallConfig,
  type LatencyBreakdown,
  type MediaSource,
  type ToolInvocation,
  type ToolRunner,
} from './turn-orchestrator.js';

// ---------------------------------------------------------------------------
// Scenario description
// ---------------------------------------------------------------------------

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** What the latency predictor believes. > 500ms fires the filler path. */
  readonly predictedMs: number;
  /** What the tool actually takes. */
  readonly actualMs: number;
  readonly result: unknown;
}

export interface ScriptedBargeIn {
  /** Milliseconds of agent audio played out before the caller starts talking. */
  readonly atPlayoutMs: number;
  readonly isTargetSpeaker?: boolean;
  readonly backchannelProbability?: number;
  readonly echoResidual?: number;
}

export interface ScriptedTurn {
  /** What the caller says. Drives the mock STT's partial stream (100ms/word). */
  readonly caller: string;
  /** What the model replies. */
  readonly reply: string;
  readonly expectedSlot?: EndpointingInput['expectedSlot'];
  /**
   * The caller trails off, then keeps going. Exercises the speculative-prefill
   * discard path: P(done) crosses 0.4, prefill starts, prosody turns back up,
   * prefill is cancelled with reason 'speculation_discarded'.
   */
  readonly falseEnding?: boolean;
  /** Model calls a tool before replying. */
  readonly tool?: ScriptedToolCall;
  /** Caller interrupts the agent's reply. */
  readonly bargeIn?: ScriptedBargeIn;
  /** Inbound energy that must NOT stop the agent (TV, "mhm", our own echo). */
  readonly rejectedBargeIn?: ScriptedBargeIn;
}

export interface SimulationOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly callId?: string;
  readonly agentId?: string;
  readonly greeting?: string;
  readonly config?: Partial<CallConfig>;
  readonly endpointing?: EndpointingStrategy;
  readonly bargeIn?: BargeInStrategy;
  /** Facts the reply is allowed to make price/policy/availability claims from. */
  readonly groundingSpans?: readonly string[];
}

export interface RecordedEvent {
  readonly type: PipelineEventName;
  readonly tMs: number;
  readonly payload: Record<string, unknown>;
}

export interface SimulationResult {
  readonly callId: string;
  readonly events: readonly RecordedEvent[];
  readonly turns: readonly LatencyBreakdown[];
  readonly states: readonly StateTransitionRecord[];
  readonly messages: readonly ChatMessage[];
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly totalCostUsd: number;
  /** Simulated call duration (== the last event's tMs). */
  readonly durationMs: number;
  /** Real time the simulation took to run. Keep this well under a second. */
  readonly wallMs: number;
}

// ---------------------------------------------------------------------------
// Timing model for the scripted caller
// ---------------------------------------------------------------------------

const FRAME_MS = 20; // the endpointer scores every 20ms (docs/01 §4)
const STT_WORD_MS = 100; // MockSttProvider emits one partial per word per 100ms
/** How long before the end of an utterance the caller's prosody starts falling. */
const CADENCE_TAIL_MS = 220;
/** Silence we let run after speech before giving up on a commit. */
const MAX_TRAILING_SILENCE_MS = 1_200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Scripted acoustic frontend.
 *
 * Emits 20ms frames with a prosody contour shaped so the semantic endpointer
 * behaves the way docs/02's timeline describes:
 *
 *   - mid-utterance: rising pitch/energy -> P(done) ~0.32, below the 0.4 speculate
 *     threshold, so we do NOT prefill on every pause
 *   - last ~320ms of speech: falling pitch, final-syllable lengthening ->
 *     P(done) ~0.55, crosses 0.4 -> SPECULATIVE PREFILL fires *while the caller is
 *     still talking* (docs/02 t=2300)
 *   - after speech ends: silence accumulates -> P(done) crosses 0.9 -> COMMIT
 *
 * With `falseEnding` the contour goes back up after the speculate crossing, which
 * is exactly the "my order number is four two seven—" case.
 */
class ScriptedMediaSource implements MediaSource {
  constructor(private readonly turns: readonly ScriptedTurn[]) {}

  hasTurn(turnIndex: number): boolean {
    return turnIndex < this.turns.length;
  }

  expectedSlot(turnIndex: number): EndpointingInput['expectedSlot'] {
    return this.turns[turnIndex]?.expectedSlot;
  }

  async *frames(turnIndex: number): AsyncIterable<AcousticFrame> {
    const turn = this.turns[turnIndex];
    if (!turn) return;

    const words = turn.caller.split(/\s+/).filter(Boolean).length;
    // Speech lasts as long as the mock STT needs to emit its partials, plus a
    // beat — otherwise we'd commit on a transcript the STT hasn't produced yet.
    const speechMs = words * STT_WORD_MS + 60;
    // The false ending has to sit clear of the real one, or the two windows merge
    // and the contour never comes back up — i.e. no discard to observe.
    const falseEndAt = turn.falseEnding ? Math.round(speechMs * 0.3) : -1;
    const falseEndUntil = falseEndAt + 140;
    const t0 = nowMs();

    let elapsed = 0;
    while (elapsed < speechMs) {
      await sleep(FRAME_MS);
      elapsed = nowMs() - t0;
      const remaining = speechMs - elapsed;
      // A false ending: falling prosody early, then the caller picks back up.
      const finishing =
        remaining <= CADENCE_TAIL_MS ||
        (falseEndAt > 0 && elapsed >= falseEndAt && elapsed < falseEndUntil);
      yield {
        tMs: Math.round(elapsed),
        speechActive: true,
        silenceMs: 0,
        prosody: finishing ? FALLING : RISING,
      };
    }

    const speechEndedAt = nowMs();
    for (;;) {
      await sleep(FRAME_MS);
      const silenceMs = nowMs() - speechEndedAt;
      if (silenceMs > MAX_TRAILING_SILENCE_MS) return; // endpointer never committed
      yield {
        tMs: Math.round(nowMs() - t0),
        speechActive: false,
        silenceMs: Math.round(silenceMs),
        prosody: FALLING,
      };
    }
  }

  bargeInProbe(turnIndex: number, playoutMs: number): Omit<BargeInInput, 'playoutMs'> | null {
    const turn = this.turns[turnIndex];
    if (!turn) return null;

    const rejected = turn.rejectedBargeIn;
    if (rejected && playoutMs >= rejected.atPlayoutMs && playoutMs < rejected.atPlayoutMs + 240) {
      return {
        speechDurationMs: Math.round(playoutMs - rejected.atPlayoutMs),
        isTargetSpeaker: rejected.isTargetSpeaker ?? true,
        backchannelProbability: rejected.backchannelProbability ?? 0.85,
        echoResidual: rejected.echoResidual ?? 0.05,
      };
    }

    const bargeIn = turn.bargeIn;
    if (bargeIn && playoutMs >= bargeIn.atPlayoutMs) {
      return {
        // Grows with playout, so the first probe is below the 120ms sustain
        // threshold (rejected) and the next one confirms — the real detector's
        // behaviour, and it proves the threshold is actually enforced.
        speechDurationMs: Math.round(playoutMs - bargeIn.atPlayoutMs),
        isTargetSpeaker: bargeIn.isTargetSpeaker ?? true,
        backchannelProbability: bargeIn.backchannelProbability ?? 0.05,
        echoResidual: bargeIn.echoResidual ?? 0.05,
      };
    }
    return null;
  }
}

/** Rising pitch + energy: the caller is mid-clause. Endpointer scores ~0.32. */
const RISING: EndpointingInput['prosody'] = {
  pitchSlope: 0.4,
  energySlope: 0.2,
  finalLengthening: 1.0,
};

/** Falling pitch + energy + final-syllable lengthening: they're finishing. */
const FALLING: EndpointingInput['prosody'] = {
  pitchSlope: -1.0,
  energySlope: -1.0,
  finalLengthening: 1.4,
};

const nowMs = () => performance.now();

// ---------------------------------------------------------------------------
// Scripted LLM — wraps MockLlmProvider to inject tool calls
// ---------------------------------------------------------------------------

/**
 * MockLlmProvider can't emit tool calls, and providers/ is out of scope to edit.
 * This wrapper injects a grammar-constrained tool call ahead of the mock's reply
 * on scripted turns, and delegates everything else — so the orchestrator's tool
 * branch is exercised by the same code path a real provider drives.
 *
 * It also fixes a scripting hazard: MockLlmProvider pops replies off a queue, one
 * per `stream()` call, but a turn issues MORE than one stream — the speculative
 * prefill, the discarded speculation, and the tool round all open one. Left alone,
 * every speculation would steal the next turn's reply and the transcript would be
 * shifted by one. So the reply for the current turn is *pinned* before each call:
 * the mock holds a live reference to `replyQueue`, so rewriting it here is enough.
 */
class ScriptedToolLlm implements LlmProvider {
  readonly key = 'scripted-tool-llm';
  readonly label = 'Mock LLM + scripted tool calls';
  readonly models: string[];

  private readonly replyQueue: string[] = [];
  private readonly inner: MockLlmProvider;

  constructor(private readonly turns: readonly ScriptedTurn[]) {
    this.inner = new MockLlmProvider(this.replyQueue);
    this.models = this.inner.models;
  }

  async *stream(opts: Parameters<LlmProvider['stream']>[0]): AsyncIterable<LlmDelta> {
    // Turn index = how many caller utterances are in context. Works for the
    // speculative prefill too, which carries the partial as the last user message.
    const turnIndex = opts.messages.filter((m) => m.role === 'user').length - 1;
    const turn = this.turns[Math.max(0, turnIndex)];

    this.replyQueue.length = 0;
    if (turn) this.replyQueue.push(turn.reply);

    const tool = turn?.tool;
    const toolAlreadyRan =
      !!tool && opts.messages.some((m) => m.role === 'tool' && m.name === tool.name);

    if (tool && !toolAlreadyRan) {
      // A tool call costs a normal prefill; the mock charges it on the first pull.
      const warm = this.inner.stream(opts)[Symbol.asyncIterator]();
      await warm.next();
      await warm.return?.(undefined as never);
      if (opts.signal?.aborted) return;
      yield {
        type: 'tool_call',
        id: `call_${tool.name}`,
        name: tool.name,
        arguments: JSON.stringify(tool.arguments),
      };
      return;
    }

    this.replyQueue.length = 0;
    if (turn) this.replyQueue.push(turn.reply);
    yield* this.inner.stream(opts);
  }
}

class ScriptedToolRunner implements ToolRunner {
  constructor(private readonly calls: readonly ScriptedToolCall[]) {}

  async run(call: ToolInvocation, signal: AbortSignal): Promise<unknown> {
    const spec = this.calls.find((c) => c.name === call.name);
    if (!spec) throw new Error(`unknown tool ${call.name}`);
    await sleep(spec.actualMs);
    if (signal.aborted) throw new Error('aborted');
    return spec.result;
  }

  predictMs(name: string): number {
    return this.calls.find((c) => c.name === name)?.predictedMs ?? 0;
  }

  fallbackUtterance(_name: string): string {
    return "I'm having trouble reaching that system — let me take a note and follow up.";
  }
}

// ---------------------------------------------------------------------------
// Default scenario
// ---------------------------------------------------------------------------

/**
 * Four turns, each covering one branch of docs/02:
 *
 *   0. the happy path, with a false ending -> speculative prefill fired AND
 *      discarded, then fired again and consumed
 *   1. a tool call whose p50 (900ms) exceeds the 500ms filler threshold
 *   2. a reply the caller interrupts -> barge-in + context truncation, preceded by
 *      a backchannel that must NOT stop the agent
 *   3. the follow-up turn, which is what proves the truncated context is coherent
 *
 * Utterances are short on purpose: the mock STT costs 100ms per word, so a chatty
 * script buys nothing but wall-clock time in CI.
 */
export const DEFAULT_SCENARIO: readonly ScriptedTurn[] = [
  {
    // Six words, so the false ending has room to sit clear of the real one.
    caller: 'hi there i need some help.',
    reply: 'Of course, happy to help.',
    falseEnding: true,
  },
  {
    caller: 'where is order 4273?',
    reply: 'Order 4273 shipped Tuesday, arriving Thursday.',
    tool: {
      name: 'get_order',
      arguments: { id: '4273' },
      predictedMs: 900, // > 500ms -> filler path
      actualMs: 180,
      result: { id: '4273', status: 'shipped', shipped: 'Tuesday', eta: 'Thursday' },
    },
  },
  {
    caller: 'can i change it?',
    reply: 'Yes, you can change the delivery address until it leaves the depot on Wednesday evening.',
    rejectedBargeIn: { atPlayoutMs: 100, backchannelProbability: 0.85 }, // "mhm" — keep talking
    bargeIn: { atPlayoutMs: 260 },
  },
  {
    caller: 'no i meant the date.',
    reply: 'Got it — the delivery date can be moved.',
  },
];

const DEFAULT_GROUNDING = [
  'order 4273 status shipped, shipped Tuesday, arriving Thursday',
  'policy: delivery address can be changed until the parcel leaves the depot on Wednesday evening',
  'policy: the delivery date can be moved once, free of charge',
];

/**
 * A second scenario for the guardrail branch — kept out of the default because it
 * is a different question ("does the chain fire?") than the default's ("is the
 * pipeline fast and coherent?").
 *
 * Turn 0 asks the identity question. The scripted model, obeying a tenant persona
 * that says to deny it, tries to say it is human — and the hard rule replaces the
 * whole clause. Turn 1 invents a price that no grounding span supports.
 */
export const GUARDRAIL_SCENARIO: readonly ScriptedTurn[] = [
  {
    caller: 'wait are you an ai?',
    reply: "No, I'm a real person here at the depot.",
  },
  {
    caller: 'how much is it?',
    reply: 'It costs $412.50, guaranteed.',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runSimulatedCall(
  opts: SimulationOptions = {},
): Promise<SimulationResult> {
  const turns = opts.turns ?? DEFAULT_SCENARIO;
  const callId = opts.callId ?? `sim_${Math.random().toString(36).slice(2, 10)}`;
  const agentId = opts.agentId ?? 'agent_sim';

  const events = new EventBus<PipelineEvents>();
  const recorded: RecordedEvent[] = [];
  events.onAny(({ type, payload }) => {
    const p = payload as { tMs?: number };
    recorded.push({
      type: type as PipelineEventName,
      tMs: p.tMs ?? 0,
      payload: payload as Record<string, unknown>,
    });
  });

  const scriptedTools = turns.flatMap((t) => (t.tool ? [t.tool] : []));
  const toolDefinitions: ToolDefinition[] = scriptedTools.map((t) => ({
    name: t.name,
    description: `scripted tool ${t.name}`,
    parameters: { type: 'object', properties: {} },
  }));

  const media = new ScriptedMediaSource(turns);
  const stt = new MockSttProvider(turns.map((t) => t.caller));
  const llm = new ScriptedToolLlm(turns);
  const tts = new MockTtsProvider();

  const config: CallConfig = {
    callId,
    agentId,
    workspaceId: 'ws_sim',
    direction: 'inbound',
    mode: 'test',
    language: 'en-US',
    voiceId: 'mock-en-f',
    model: 'mock-fast',
    systemPrompt: 'You are a helpful order-support agent for a retailer.',
    greeting: 'Thanks for calling, how can I help?',
    fillerText: 'Let me pull that up for you.',
    tools: toolDefinitions,
    groundingSpans: opts.groundingSpans ?? DEFAULT_GROUNDING,
    // A fast talker's baseline. The endpointer scales its silence term by this, so
    // this is what "adaptive threshold per call" (docs/01 §4) actually means here.
    callerBaseline: { meanPauseMs: 130, stdPauseMs: 55 },
    ...opts.config,
  };

  const orchestrator = new TurnOrchestrator(config, {
    events,
    stt,
    llm,
    tts,
    endpointing: opts.endpointing ?? new SemanticEndpointing(),
    bargeIn: opts.bargeIn ?? new TargetSpeakerBargeIn(),
    media,
    guardrails: buildGuardrailChain(),
    toolRunner: new ScriptedToolRunner(scriptedTools),
  });

  const wallStart = nowMs();
  const result = await orchestrator.run();
  const wallMs = Math.round(nowMs() - wallStart);

  const totals = result.turns.map((t) => t.totalMs);
  return {
    callId,
    events: recorded,
    turns: result.turns,
    states: result.states,
    messages: result.messages,
    p50Ms: percentile(totals, 50),
    p95Ms: percentile(totals, 95),
    totalCostUsd: result.totalCostUsd,
    durationMs: result.durationMs,
    wallMs,
  };
}

/** Nearest-rank percentile. Small n, so no interpolation games. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/**
 * Run the same scenario N times and report the distribution. This is what the eval
 * harness calls: one call is an anecdote, and the numbers docs/01 §1 commits to are
 * p50 and p95.
 */
export async function runLatencyEval(
  opts: SimulationOptions & { runs?: number } = {},
): Promise<{
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  samples: number[];
  runs: SimulationResult[];
}> {
  const { runs = 5, ...simOpts } = opts;

  // Guard rather than silently returning an empty distribution. A latency eval
  // that reports p50=0 because of a bad argument is worse than one that throws:
  // it looks like a passing result.
  if (!Number.isInteger(runs) || runs < 1) {
    throw new TypeError(`runLatencyEval: "runs" must be a positive integer, got ${JSON.stringify(runs)}`);
  }

  const results: SimulationResult[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await runSimulatedCall({ ...simOpts, callId: `sim_eval_${i}` }));
  }
  const samples = results.flatMap((r) => r.turns.map((t) => t.totalMs));
  if (!samples.length) {
    throw new Error(
      'runLatencyEval produced no turn samples — the scenario completed without a single ' +
        'turn.completed event, which means the pipeline is broken, not fast',
    );
  }
  return {
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Math.max(...samples),
    samples,
    runs: results,
  };
}
