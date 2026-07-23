/**
 * Strategy pattern.
 *
 * The behaviours we expect to iterate on hardest — when a turn ends, when to yield
 * to a barge-in, which cell takes a call, which model handles a turn — are each
 * behind a Strategy interface and selected per-agent from config.
 *
 * This is what makes the migration in docs/05-orchestration.md possible: swap
 * LiveKit's text-only turn detector for our prosody-aware one by changing a
 * registry key, and A/B them against each other on live traffic.
 */

import type { Logger } from './factory.js';

export interface Strategy<TInput, TOutput> {
  readonly key: string;
  readonly label: string;
  decide(input: TInput): TOutput | Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Endpointing — "has the caller finished speaking?"
// ---------------------------------------------------------------------------

export interface EndpointingInput {
  /** Milliseconds of silence since the last speech frame. */
  readonly silenceMs: number;
  /** Best-effort transcript so far for this turn. */
  readonly partialTranscript: string;
  /** Prosody features from the media node. Absent when unavailable (e.g. v1). */
  readonly prosody?: {
    /** Normalised slope of F0 over the final ~300ms. Negative = falling = done. */
    readonly pitchSlope: number;
    /** Normalised energy slope over the final ~300ms. */
    readonly energySlope: number;
    /** Final-syllable lengthening ratio vs. the speaker's baseline. */
    readonly finalLengthening: number;
  };
  /** Rolling stats for this caller, used to adapt to fast vs. slow talkers. */
  readonly callerBaseline: {
    readonly meanPauseMs: number;
    readonly stdPauseMs: number;
  };
  /** What the dialogue engine expects next — an ID slot waits longer than a yes/no. */
  readonly expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
}

export interface EndpointingDecision {
  /** P(the caller has finished their turn). */
  readonly probability: number;
  /** Cross this to start speculative LLM prefill (docs/02-call-flow.md). */
  readonly shouldSpeculate: boolean;
  /** Cross this to commit the turn and start decoding. */
  readonly shouldCommit: boolean;
  /** For the trace viewer — why this decision was made. */
  readonly reason: string;
}

export type EndpointingStrategy = Strategy<EndpointingInput, EndpointingDecision>;

// ---------------------------------------------------------------------------
// Barge-in — "should the agent stop talking?"
// ---------------------------------------------------------------------------

export interface BargeInInput {
  /** Sustained duration of detected speech, in ms. */
  readonly speechDurationMs: number;
  /** Is this the enrolled primary caller, or background/other speaker? */
  readonly isTargetSpeaker: boolean;
  /** Confidence that this is a backchannel ("mhm", "right") not an interruption. */
  readonly backchannelProbability: number;
  /** Post-AEC residual — high means we may be hearing our own playout. */
  readonly echoResidual: number;
  /** How much of the agent's utterance has actually been played out. */
  readonly playoutMs: number;
}

export interface BargeInDecision {
  readonly yield: boolean;
  readonly reason:
    | 'confirmed_interruption'
    | 'below_duration_threshold'
    | 'not_target_speaker'
    | 'backchannel'
    | 'echo_suspected';
}

export type BargeInStrategy = Strategy<BargeInInput, BargeInDecision>;

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * Baseline: fixed silence threshold. This is what Vapi/Retell effectively do.
 *
 * Kept deliberately, as the control arm for A/B tests — you cannot claim a 300ms
 * win without measuring against the thing you claim to beat.
 */
export class FixedSilenceEndpointing implements EndpointingStrategy {
  readonly key = 'fixed-silence';
  readonly label = 'Fixed silence threshold (baseline)';

  constructor(private readonly thresholdMs = 700) {}

  decide(input: EndpointingInput): EndpointingDecision {
    const p = Math.min(1, input.silenceMs / this.thresholdMs);
    return {
      probability: p,
      shouldSpeculate: false, // no early signal to speculate on
      shouldCommit: input.silenceMs >= this.thresholdMs,
      reason: `silence ${input.silenceMs}ms / ${this.thresholdMs}ms`,
    };
  }
}

/**
 * Semantic endpointing — docs/01-architecture.md §4.
 *
 * Combines syntactic completeness, prosody, and per-caller adaptation. The real
 * implementation swaps the heuristic scorer below for an ONNX model; the interface
 * and the thresholds stay identical, which is the point of putting it behind a
 * Strategy in the first place.
 */
export class SemanticEndpointing implements EndpointingStrategy {
  readonly key = 'semantic';
  readonly label = 'Semantic endpointing (prosody + text + adaptive)';

  constructor(
    private readonly opts: {
      speculateThreshold?: number;
      commitThreshold?: number;
      /** Absolute ceiling before committing regardless of confidence. */
      maxWaitMs?: number;
      logger?: Logger;
    } = {},
  ) {}

  private get speculateThreshold() {
    return this.opts.speculateThreshold ?? 0.4;
  }
  private get commitThreshold() {
    return this.opts.commitThreshold ?? 0.9;
  }

  /** Absolute ceiling. Past this we commit regardless, so a trailing-off caller
   *  can never hang the turn forever. */
  private get maxWaitMs() {
    return this.opts.maxWaitMs ?? 1500;
  }

  decide(input: EndpointingInput): EndpointingDecision {
    const reasons: string[] = [];

    // 1. Syntactic completeness. NOTE: ASR output has no punctuation, so absence
    //    of a full stop carries no information — scoring it as "incomplete" was a
    //    calibration bug that made the commit threshold unreachable in practice.
    const syntax = syntacticCompleteness(input.partialTranscript);
    reasons.push(`syntax=${syntax.toFixed(2)}`);

    // 2. Prosody. Falling pitch + falling energy = finished. Rising = still going,
    //    even after a long pause ("my number is four two seven—").
    let prosodyScore = 0.5;
    if (input.prosody) {
      const { pitchSlope, energySlope, finalLengthening } = input.prosody;
      prosodyScore = clamp01(
        0.5 - pitchSlope * 0.35 - energySlope * 0.25 - (finalLengthening - 1) * 0.3,
      );
      reasons.push(`prosody=${prosodyScore.toFixed(2)}`);
    }

    // Semantic confidence: does this LOOK and SOUND finished, independent of how
    // long they've been quiet? This is the whole point of semantic endpointing —
    // when someone has clearly finished, you don't wait out a silence timer.
    const semantic = clamp01(syntax * 0.45 + prosodyScore * 0.55);

    // 3. Silence acts as a fast GATE on that confidence rather than as an equal
    //    third of the score. Scaled to THIS caller's rhythm: a fast talker's
    //    200ms pause means what a slow talker's 600ms means.
    const baseline = Math.max(120, input.callerBaseline.meanPauseMs);
    const gate = clamp01(input.silenceMs / (baseline * 0.4));
    reasons.push(`gate=${gate.toFixed(2)}`);

    // 4. Overrun: once they've been quiet for longer than their own normal pause,
    //    confidence climbs regardless of how ambiguous the words were. This is
    //    what eventually ends an unclear turn without a hard timer.
    const overrun = clamp01((input.silenceMs - baseline) / baseline);

    const gated = semantic * gate;
    let probability = gated + (1 - gated) * overrun * 0.9;

    // 5. Slot expectation. Mid-ID pauses are normal; don't cut people off.
    const slotPenalty = this.slotPenalty(input);
    if (slotPenalty !== 0) reasons.push(`slot=${(-slotPenalty).toFixed(2)}`);
    probability = clamp01(probability - slotPenalty);

    // 6. Safety net. A caller who trails off mid-sentence must still get a reply.
    if (input.silenceMs >= this.maxWaitMs) {
      probability = Math.max(probability, 0.95);
      reasons.push('maxWait');
    }

    return {
      probability,
      shouldSpeculate: probability >= this.speculateThreshold,
      shouldCommit: probability >= this.commitThreshold,
      reason: reasons.join(' '),
    };
  }

  private slotPenalty(input: EndpointingInput): number {
    if (!input.expectedSlot) return 0;
    const text = input.partialTranscript.trim();
    switch (input.expectedSlot) {
      case 'digits': {
        // Callers group digits with pauses. Hold until the expected length or a
        // clearly terminal cue.
        const digits = (text.match(/\d/g) ?? []).length;
        return digits > 0 && digits < 6 ? 0.35 : 0;
      }
      case 'email':
        // Nobody says an email address in one breath.
        return /@/.test(text) ? 0 : 0.3;
      case 'name':
        return text.length < 3 ? 0.2 : 0;
      case 'yes_no':
        // Short answers are complete answers — bias toward responding fast.
        return -0.15;
      default:
        return 0;
    }
  }
}

/**
 * Barge-in with target-speaker gating — docs/03-problem-coverage.md §A.
 *
 * The order of these checks is the whole design: reject echo and background
 * speakers BEFORE the duration timer, so a TV in the background never starts the
 * 120ms clock in the first place.
 */
export class TargetSpeakerBargeIn implements BargeInStrategy {
  readonly key = 'target-speaker';
  readonly label = 'Target-speaker barge-in (noise robust)';

  constructor(
    private readonly opts: {
      minDurationMs?: number;
      backchannelThreshold?: number;
      echoThreshold?: number;
    } = {},
  ) {}

  decide(input: BargeInInput): BargeInDecision {
    if (input.echoResidual > (this.opts.echoThreshold ?? 0.35)) {
      return { yield: false, reason: 'echo_suspected' };
    }
    if (!input.isTargetSpeaker) {
      return { yield: false, reason: 'not_target_speaker' };
    }
    if (input.backchannelProbability > (this.opts.backchannelThreshold ?? 0.6)) {
      return { yield: false, reason: 'backchannel' };
    }
    if (input.speechDurationMs < (this.opts.minDurationMs ?? 120)) {
      return { yield: false, reason: 'below_duration_threshold' };
    }
    return { yield: true, reason: 'confirmed_interruption' };
  }
}

/** Naive baseline: any speech interrupts. Control arm — and what most platforms ship. */
export class AnySpeechBargeIn implements BargeInStrategy {
  readonly key = 'any-speech';
  readonly label = 'Any speech (baseline)';

  decide(input: BargeInInput): BargeInDecision {
    return input.speechDurationMs > 0
      ? { yield: true, reason: 'confirmed_interruption' }
      : { yield: false, reason: 'below_duration_threshold' };
  }
}

// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Words that cannot end a finished thought. Ending on one of these is the single
 * strongest signal that the caller is still mid-clause, regardless of how long
 * they pause — "i was wondering if you could maybe…" is not a complete turn.
 */
const TRAILING_CONTINUATION =
  /\b(and|or|but|so|because|the|a|an|my|your|is|are|was|were|to|for|with|of|at|in|on|that|if|when|maybe|perhaps|just|like|about|into|from|than|then|its|it's|i'm|we're|you're)$/i;

/**
 * Rough syntactic-completeness proxy. Replaced by the ONNX model in production.
 *
 * Calibration note: streaming ASR emits text WITHOUT punctuation, so a missing
 * full stop is not evidence of incompleteness. Scoring it as such capped the
 * achievable probability below the commit threshold and made the endpointer
 * behave like the fixed-silence baseline it exists to beat.
 */
function syntacticCompleteness(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  if (/[.!?]$/.test(t)) return 0.95; // punctuation, when present, is strong evidence
  if (TRAILING_CONTINUATION.test(t)) return 0.05; // clearly mid-clause
  if (/\b(um|uh|er|hmm)$/i.test(t)) return 0.1; // filled pause = still thinking
  const words = t.split(/\s+/).length;
  if (words <= 2) return 0.8; // "yes" / "okay" are complete turns, not fragments
  return 0.9; // a multi-word clause not ending mid-thought
}
