/**
 * Synthetic call traces.
 *
 * The trace viewer is the highest-value screen in the product (docs/07), and it
 * cannot be built, styled, or demoed against an empty database. These fixtures
 * produce traces with the same statistical shape as the real pipeline so that a
 * layout which looks fine on fake data still looks fine in production:
 *
 *   - the latency budget of docs/01 §1 — p50 ~320ms, p95 ~600ms, with the split
 *     across endpointing / STT / LLM TTFT / TTS TTFB / network that the waterfall
 *     bars decompose, and components that sum EXACTLY to `totalMs`
 *   - occasional outliers, because a viewer that never renders a 900ms turn has
 *     never been tested against the case people actually open it for
 *   - at least one barge-in with `playedOutChars` < generated length (docs/02
 *     §barge-in — the bookkeeping the viewer exists to make visible)
 *   - at least one tool call over the 500ms threshold, with the filler it triggers
 *   - PII in a couple of transcripts, so the `call:read_pii` masking in
 *     `CallService` is visible in the UI rather than only in a unit test
 *
 * Fully deterministic: same seed, byte-identical trace. Screenshot diffs and
 * fixture-backed tests are worthless otherwise, which is why there is a hand-rolled
 * PRNG below instead of `Math.random`.
 */

import { newId } from '../domain/ids.js';
import { callTraceSchema, type Call, type CallTrace, type LatencyBreakdown, type TraceEvent, type TraceToolCall, type Turn } from '../domain/call-schemas.js';

// ---------------------------------------------------------------------------
// Seeded PRNG — xorshift32
// ---------------------------------------------------------------------------

class Rng {
  private state: number;

  constructor(seed: number) {
    // Zero is a fixed point of xorshift; any non-zero constant will do.
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return ((x >>> 0) % 0x1_0000_0000) / 0x1_0000_0000;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Mean-reverting sample: two draws averaged, so the middle is far likelier. */
  around(min: number, max: number): number {
    return (this.float(min, max) + this.float(min, max)) / 2;
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    // Non-empty by construction at every call site; the fallback keeps
    // noUncheckedIndexedAccess honest without a non-null assertion.
    return items[this.int(0, items.length - 1)] ?? (items[0] as T);
  }
}

// ---------------------------------------------------------------------------
// Latency model — docs/01 §1, "This platform" column
// ---------------------------------------------------------------------------

/**
 * Component ranges, in ms. The midpoints sum to ~322ms, which is the p50 the
 * architecture doc commits to. `networkMs` folds packetization, carrier hop and
 * encode/RTP-out into the single figure the viewer shows.
 */
const LATENCY_MODEL = {
  endpointing: [40, 115],
  sttFinalize: [0, 35],
  llmTtftCached: [85, 140],
  llmTtftCold: [150, 235],
  ttsTtfb: [55, 105],
  network: [20, 40],
} as const;

/** ~1 turn in 7 is an outlier. Enough to be visible, rare enough to stay p50-honest. */
const OUTLIER_PROBABILITY = 0.15;
const PREFIX_CACHE_HIT_RATE = 0.85;

function sampleLatency(rng: Rng): LatencyBreakdown {
  const prefixCacheHit = rng.bool(PREFIX_CACHE_HIT_RATE);
  const outlier = rng.bool(OUTLIER_PROBABILITY);

  const [epLo, epHi] = LATENCY_MODEL.endpointing;
  const [sttLo, sttHi] = LATENCY_MODEL.sttFinalize;
  const [ttsLo, ttsHi] = LATENCY_MODEL.ttsTtfb;
  const [netLo, netHi] = LATENCY_MODEL.network;
  const [llmLo, llmHi] = prefixCacheHit
    ? LATENCY_MODEL.llmTtftCached
    : LATENCY_MODEL.llmTtftCold;

  // An outlier is not a uniformly slower turn: it is one stage queueing. That is
  // what a real p99 looks like, and the waterfall should show which bar blew up.
  const llmStretch = outlier ? rng.float(1.8, 3.4) : 1;
  const ttsStretch = outlier && rng.bool(0.4) ? rng.float(1.5, 2.5) : 1;

  const endpointingMs = Math.round(rng.around(epLo, epHi));
  const sttFinalizeMs = Math.round(rng.around(sttLo, sttHi));
  const llmTtftMs = Math.round(rng.around(llmLo, llmHi) * llmStretch);
  const ttsTtfbMs = Math.round(rng.around(ttsLo, ttsHi) * ttsStretch);
  const networkMs = Math.round(rng.around(netLo, netHi));

  const promptTokens = rng.int(900, 2600);
  const cachedTokens = prefixCacheHit
    ? Math.round(promptTokens * rng.float(0.82, 0.97))
    : rng.int(0, Math.round(promptTokens * 0.1));

  return {
    // Sums exactly — the bars must add up to the headline number.
    totalMs: endpointingMs + sttFinalizeMs + llmTtftMs + ttsTtfbMs + networkMs,
    endpointingMs,
    sttFinalizeMs,
    llmTtftMs,
    ttsTtfbMs,
    networkMs,
    prefixCacheHit,
    promptTokens,
    cachedTokens,
    completionTokens: rng.int(18, 120),
  };
}

// ---------------------------------------------------------------------------
// Conversation material
// ---------------------------------------------------------------------------

/** Two of these carry PII on purpose — see the module note on masking. */
const CALLER_LINES = [
  'Hi, I want to check my order status.',
  'It was supposed to arrive on Tuesday and nothing showed up.',
  'The order number is 4273918.',
  'You can reach me at alex.moreau@example.com if it changes.',
  'I paid with the card ending in, hold on, 4539 8712 3344 9021.',
  'No, that address is the old one.',
  'Can you just cancel it and refund me?',
  'How long does the refund usually take?',
  'Actually, wait, I also had a second package.',
  'Okay, and can someone call me back on 15112345678?',
  'That works. Thanks for your help.',
  'One more thing before you go.',
];

const AGENT_LINES = [
  'Sure, I can help with that. Let me pull up your order.',
  'I see it left the warehouse on Monday and is currently in transit.',
  'Thanks. I have found the order and I can see the delay on the carrier side.',
  'I have noted that contact address on the account.',
  'I will not repeat the card details back to you, they are recorded securely.',
  'Understood, I will use the address on file instead.',
  'I can cancel that for you and start the refund right away.',
  'Refunds normally settle within three to five business days.',
  'Let me check whether the second package shipped separately.',
  'I have scheduled a callback for later today on that number.',
  'Happy to help. Is there anything else I can do for you?',
  'Of course, go ahead.',
];

const TOOLS = [
  { name: 'get_order', request: { orderId: '4273918' }, response: { status: 'in_transit', eta: '2026-07-24' } },
  { name: 'lookup_customer', request: { phone: '+4915112345678' }, response: { tier: 'gold', openTickets: 0 } },
  { name: 'issue_refund', request: { orderId: '4273918', amount: 89.9 }, response: { refundId: 're_8812', status: 'pending' } },
] as const;

const FILLER_TEXT = 'Let me pull that up for you.';

// ---------------------------------------------------------------------------

export interface GenerateTraceOptions {
  seed: number;
  orgId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  agentVersion?: number;
  mode?: 'test' | 'live';
  direction?: 'inbound' | 'outbound';
  /** Call start, ISO 8601. Defaults to a fixed instant so output stays reproducible. */
  startedAt?: string;
}

const DEFAULT_STARTED_AT = '2026-07-22T09:15:00.000Z';
const WAVEFORM_BIN_MS = 100;
/** Speaking rate: ~16 characters per second is close to natural TTS output. */
const MS_PER_CHAR = 62;
/** docs/02 §tool call — past this, the caller hears a filler instead of dead air. */
const FILLER_THRESHOLD_MS = 500;

/**
 * One complete call: the `Call` row, its turns, the raw event stream behind them,
 * and the waveform envelopes. Validated against the contract schema before it is
 * returned, so a fixture can never drift from the shape the dashboard expects.
 */
export function generateTrace(opts: GenerateTraceOptions): CallTrace {
  const rng = new Rng(opts.seed);
  const events: TraceEvent[] = [];
  const turns: Turn[] = [];

  // 6-12 turns total, alternating — 3 to 6 caller/agent exchanges.
  const exchanges = rng.int(3, 6);
  // Guarantee the two cases the viewer is built to show, on distinct exchanges.
  const bargeInAt = rng.int(1, exchanges - 1);
  const slowToolAt = bargeInAt === 0 ? 1 : 0;

  const callerSpans: Array<[number, number]> = [];
  const agentSpans: Array<[number, number]> = [];

  let t = rng.int(400, 1200); // ring-to-first-word gap

  for (let ex = 0; ex < exchanges; ex += 1) {
    // -- Caller turn -------------------------------------------------------
    const callerText = CALLER_LINES[(ex * 2) % CALLER_LINES.length] ?? CALLER_LINES[0]!;
    const callerStart = t;
    const callerDurationMs = Math.round(callerText.length * MS_PER_CHAR * rng.float(0.9, 1.3));
    const speechEnd = callerStart + callerDurationMs;

    events.push({ tMs: callerStart, lane: 'vad', type: 'speech_start' });
    // P(done) curve, sampled coarsely — the real endpointer emits every 20ms, but a
    // fixture does not need 30k points to prove the lane renders.
    for (let s = callerStart + 200; s < speechEnd; s += 200) {
      const progress = (s - callerStart) / Math.max(1, callerDurationMs);
      events.push({
        tMs: s,
        lane: 'endpoint',
        type: 'score',
        value: Number((progress * 0.55 * rng.float(0.85, 1.15)).toFixed(3)),
        text: 'partial_text+prosody',
      });
      if (s + 200 >= speechEnd) {
        events.push({ tMs: s, lane: 'llm', type: 'speculate', value: 0.42 });
        events.push({ tMs: s + 5, lane: 'llm', type: 'prefill_speculative' });
      }
      events.push({ tMs: s, lane: 'stt', type: 'partial', value: 0.71, text: callerText.slice(0, Math.ceil(callerText.length * progress)) });
    }
    events.push({ tMs: speechEnd, lane: 'vad', type: 'speech_end' });

    const latency = sampleLatency(rng);
    const commitAt = speechEnd + latency.endpointingMs;
    events.push({ tMs: commitAt, lane: 'endpoint', type: 'commit', value: 0.93 });
    events.push({ tMs: commitAt + latency.sttFinalizeMs, lane: 'stt', type: 'final', value: 0.94, text: callerText });

    callerSpans.push([callerStart, speechEnd]);
    turns.push({
      index: turns.length,
      role: 'caller',
      transcript: callerText,
      startMs: callerStart,
      endMs: speechEnd,
    });

    // -- Agent turn --------------------------------------------------------
    const agentText = AGENT_LINES[(ex * 2 + 1) % AGENT_LINES.length] ?? AGENT_LINES[0]!;
    const firstAudioAt = speechEnd + latency.totalMs;
    const fullPlayoutMs = Math.round(agentText.length * MS_PER_CHAR);

    events.push({
      tMs: commitAt + latency.sttFinalizeMs + 5,
      lane: 'llm',
      type: 'prefill',
    });
    events.push({
      tMs: firstAudioAt - latency.ttsTtfbMs - latency.networkMs,
      lane: 'llm',
      type: 'first_token',
      value: latency.llmTtftMs,
    });
    events.push({ tMs: firstAudioAt, lane: 'tts', type: 'first_audio', value: latency.ttsTtfbMs });
    events.push({ tMs: firstAudioAt, lane: 'endpoint', type: 'turn_completed', value: latency.totalMs });

    const agentTurn: Turn = {
      index: turns.length,
      role: 'agent',
      transcript: agentText,
      startMs: firstAudioAt,
      endMs: firstAudioAt + fullPlayoutMs,
      latency,
    };

    // -- Tool branch -------------------------------------------------------
    // The slow one is forced; the rest are sampled, so most calls have a mix.
    const wantsTool = ex === slowToolAt || rng.bool(0.35);
    if (wantsTool) {
      const spec = ex === slowToolAt ? TOOLS[0] : rng.pick(TOOLS);
      const durationMs =
        ex === slowToolAt ? rng.int(620, 1400) : rng.int(90, 480);
      const toolStart = commitAt + latency.sttFinalizeMs + rng.int(60, 140);
      const status: TraceToolCall['status'] = durationMs > 1300 ? 'timeout' : 'ok';

      events.push({ tMs: toolStart, lane: 'tool', type: 'started', text: spec.name });
      if (durationMs > FILLER_THRESHOLD_MS) {
        // Predicted-slow tool: the filler is what the caller actually hears first.
        events.push({ tMs: toolStart + 10, lane: 'tool', type: 'filler', text: FILLER_TEXT });
        agentSpans.push([firstAudioAt, firstAudioAt + FILLER_TEXT.length * MS_PER_CHAR]);
      }
      events.push({
        tMs: toolStart + durationMs,
        lane: 'tool',
        type: status,
        value: durationMs,
        text: spec.name,
      });

      agentTurn.toolCalls = [
        {
          name: spec.name,
          startMs: toolStart,
          durationMs,
          status,
          request: spec.request,
          response: status === 'timeout' ? null : spec.response,
        },
      ];
      // The reply itself only starts after the tool returns.
      agentTurn.endMs = Math.max(agentTurn.endMs, toolStart + durationMs + fullPlayoutMs);
    }

    if (rng.bool(0.25)) {
      events.push({
        tMs: firstAudioAt + 20,
        lane: 'guardrail',
        type: 'pass',
        text: 'grounded: every claim supported by tool output',
      });
      agentTurn.guardrails = [
        { key: 'grounded', action: 'pass', reason: 'every claim supported by tool output' },
      ];
    }

    // -- Barge-in branch ---------------------------------------------------
    if (ex === bargeInAt) {
      const heardFraction = rng.float(0.28, 0.68);
      const playedOutMs = Math.round(fullPlayoutMs * heardFraction);
      const bargeAt = firstAudioAt + playedOutMs;

      events.push({ tMs: bargeAt, lane: 'bargein', type: 'detected', value: 120 });
      events.push({ tMs: bargeAt + 5, lane: 'llm', type: 'cancelled', text: 'barge_in' });
      events.push({ tMs: bargeAt + 10, lane: 'tts', type: 'cancelled', value: playedOutMs });
      // The number everyone gets wrong: context is truncated to what was HEARD.
      const playedOutChars = Math.max(1, Math.floor(agentText.length * heardFraction));
      events.push({ tMs: bargeAt + 12, lane: 'bargein', type: 'truncated', value: playedOutChars });

      agentTurn.interrupted = true;
      agentTurn.playedOutChars = playedOutChars;
      agentTurn.endMs = bargeAt;
      agentSpans.push([firstAudioAt, bargeAt]);
      turns.push(agentTurn);
      t = bargeAt + rng.int(0, 120); // the caller is already talking over the tail
      continue;
    }

    events.push({ tMs: agentTurn.endMs, lane: 'tts', type: 'done', value: fullPlayoutMs });
    agentSpans.push([firstAudioAt, agentTurn.endMs]);
    turns.push(agentTurn);
    t = agentTurn.endMs + rng.int(250, 900);
  }

  // -- Roll up ------------------------------------------------------------
  const durationMs = t + rng.int(300, 1500);
  const latencies = turns.flatMap((turn) => (turn.latency ? [turn.latency.totalMs] : []));
  const startedAt = opts.startedAt ?? DEFAULT_STARTED_AT;
  const endedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  const durationSec = Math.round(durationMs / 1000);
  const direction = opts.direction ?? (rng.bool(0.7) ? 'inbound' : 'outbound');
  const bargeInCount = turns.filter((turn) => turn.interrupted).length;

  const call: Call = {
    id: newId('call'),
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    agentId: opts.agentId,
    agentName: opts.agentName,
    mode: opts.mode ?? 'test',
    direction,
    status: 'completed',
    outcome: pickOutcome(rng, bargeInCount),
    fromNumber: direction === 'inbound' ? '+4915112345678' : '+493012345678',
    toNumber: direction === 'inbound' ? '+493012345678' : '+4915112345678',
    startedAt,
    endedAt,
    durationSec,
    turnCount: turns.length,
    medianLatencyMs: Math.round(percentile(latencies, 50)),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    // ~$0.09/min all-in at the co-located cost structure of docs/01.
    costUsd: Number(((durationSec / 60) * 0.09).toFixed(4)),
    bargeInCount,
    agentVersion: opts.agentVersion ?? 1,
  };

  const trace: CallTrace = {
    call,
    turns,
    events: events.sort((a, b) => a.tMs - b.tMs),
    waveform: buildWaveform(rng, callerSpans, agentSpans, durationMs),
  };

  // Parse rather than cast: a fixture that cannot satisfy the contract is a bug in
  // the generator, and it should fail here rather than in the browser.
  return callTraceSchema.parse(trace);
}

/** A workspace's worth of calls. Seeds are derived, so the set is reproducible. */
export function generateTraces(
  count: number,
  opts: GenerateTraceOptions,
): CallTrace[] {
  const spacing = 7 * 60_000; // one call every 7 minutes, newest last
  const base = Date.parse(opts.startedAt ?? DEFAULT_STARTED_AT);
  return Array.from({ length: count }, (_, i) =>
    generateTrace({
      ...opts,
      seed: opts.seed + i * 2_654_435_761,
      startedAt: new Date(base + i * spacing).toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------

function pickOutcome(rng: Rng, bargeInCount: number) {
  // Interruption-heavy calls escalate more often — the correlation makes the call
  // log's filters produce interesting results instead of uniform noise.
  const roll = rng.next() - bargeInCount * 0.08;
  if (roll > 0.35) return 'resolved' as const;
  if (roll > 0.15) return 'escalated' as const;
  if (roll > 0.05) return 'abandoned' as const;
  return 'voicemail' as const;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Amplitude envelopes, 0..1, one value per bin. Shaped rather than flat: the viewer
 * draws these as a waveform, and a rectangle would hide any bug in its scaling.
 */
function buildWaveform(
  rng: Rng,
  callerSpans: ReadonlyArray<readonly [number, number]>,
  agentSpans: ReadonlyArray<readonly [number, number]>,
  durationMs: number,
): CallTrace['waveform'] {
  const bins = Math.max(1, Math.ceil(durationMs / WAVEFORM_BIN_MS));

  const lane = (spans: ReadonlyArray<readonly [number, number]>): number[] => {
    const out = new Array<number>(bins).fill(0);
    for (let i = 0; i < bins; i += 1) {
      // Room tone, so silence is not a dead flat line.
      out[i] = Number(rng.float(0, 0.04).toFixed(3));
    }
    for (const [start, end] of spans) {
      const from = Math.max(0, Math.floor(start / WAVEFORM_BIN_MS));
      const to = Math.min(bins - 1, Math.floor(end / WAVEFORM_BIN_MS));
      const width = Math.max(1, to - from);
      for (let i = from; i <= to; i += 1) {
        // Envelope: fast attack, syllabic ripple, decay at the tail.
        const pos = (i - from) / width;
        const attack = Math.min(1, pos * 8);
        const decay = Math.min(1, (1 - pos) * 6);
        const ripple = 0.65 + 0.35 * Math.abs(Math.sin(i * 1.7));
        const value = attack * decay * ripple * rng.float(0.75, 1);
        out[i] = Number(Math.min(1, Math.max(0, value)).toFixed(3));
      }
    }
    return out;
  };

  return { caller: lane(callerSpans), agent: lane(agentSpans), binMs: WAVEFORM_BIN_MS };
}
