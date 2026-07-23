/**
 * Call state machine — docs/02-call-flow.md §The full state machine.
 *
 * The mermaid diagram in docs/02 is the specification; the table below is a
 * literal transcription of it, plus four documented extensions (see EXTENSIONS).
 *
 * WHY a real FSM instead of a `let state = '...'`:
 *   - The illegal transitions are the interesting ones. "SPEAKING -> THINKING"
 *     without passing through BARGE_IN means we started a second generation while
 *     the first was still in the caller's ear — two voices on one call. That must
 *     fail loudly in dev and in CI, not produce a weird call recording.
 *   - Every transition is timestamped and kept, so the trace viewer can render the
 *     state lane underneath the latency waterfall without a second instrumentation
 *     pass.
 */

export type CallState =
  | 'GREETING'
  | 'LISTENING'
  | 'SPECULATING'
  | 'THINKING'
  | 'TOOL_CALL'
  | 'FILLER'
  | 'SPEAKING'
  | 'BARGE_IN'
  | 'HOLD'
  | 'HANDOFF'
  | 'ENDED';

/**
 * Transition triggers. Naming follows the mermaid edge labels so the diagram and
 * the code can be diffed by eye.
 */
export type CallTrigger =
  | 'call_answered'
  | 'greeting_playout_done'
  | 'partial_transcript'
  | 'speculate_threshold'
  | 'speculation_discarded'
  | 'turn_commit'
  | 'first_clause'
  | 'tool_call'
  | 'tool_slow'
  | 'tool_result'
  | 'playout_complete'
  | 'barge_in_confirmed'
  | 'context_truncated'
  | 'silence_timeout'
  | 'reprompt_played'
  | 'escalation'
  | 'reverse_handoff'
  | 'transfer_complete'
  | 'hangup';

export interface StateTransitionRecord {
  readonly from: CallState;
  readonly to: CallState;
  readonly trigger: CallTrigger;
  /** Milliseconds since call start, matching the `tMs` on every pipeline event. */
  readonly tMs: number;
}

/**
 * Deviations from the mermaid diagram, each deliberate:
 *
 *  1. `LISTENING -> THINKING (turn_commit)`. The diagram only commits out of
 *     SPECULATING, which is correct for the semantic endpointer. But the baseline
 *     `FixedSilenceEndpointing` never sets `shouldSpeculate` (strategy.ts:109), so
 *     the control arm of every A/B test commits straight from LISTENING. Without
 *     this edge the baseline cannot run at all, and docs/05 requires it to.
 *  2. `GREETING -> BARGE_IN`. Callers interrupt greetings constantly ("yeah hi, I
 *     need—"). Same kill/truncate bookkeeping as any other barge-in.
 *  3. `HOLD` is the diagram's `Reprompt` node. Renamed for the state enum, same
 *     semantics: silence > N seconds, play a reprompt, return to LISTENING.
 *  4. `* -> ENDED (hangup)`. The diagram draws hangup only from Speaking; in
 *     reality the carrier can tear the leg down in any state. Allowed from
 *     everywhere, and only via the `hangup` trigger.
 */
export const EXTENSIONS = [
  'LISTENING->THINKING (baseline endpointer never speculates)',
  'GREETING->BARGE_IN (caller interrupts the greeting)',
  'HOLD == diagram Reprompt node',
  '*->ENDED (hangup can arrive in any state)',
  'THINKING/TOOL_CALL/FILLER->LISTENING (a reply that produced no audio still returns the floor)',
] as const;

type Edges = Readonly<Record<CallState, ReadonlyArray<readonly [CallTrigger, CallState]>>>;

/** The transition table. Anything not listed here is a bug, by construction. */
export const TRANSITIONS: Edges = {
  GREETING: [
    ['greeting_playout_done', 'LISTENING'],
    ['barge_in_confirmed', 'BARGE_IN'],
  ],
  LISTENING: [
    ['partial_transcript', 'LISTENING'], // self-loop: P(done) < commit threshold
    ['speculate_threshold', 'SPECULATING'],
    ['turn_commit', 'THINKING'], // extension 1
    ['silence_timeout', 'HOLD'],
    ['escalation', 'HANDOFF'],
  ],
  SPECULATING: [
    ['speculation_discarded', 'LISTENING'], // caller resumed; prefill thrown away
    ['turn_commit', 'THINKING'],
    ['escalation', 'HANDOFF'],
  ],
  THINKING: [
    ['first_clause', 'SPEAKING'],
    ['tool_call', 'TOOL_CALL'],
    ['playout_complete', 'LISTENING'], // extension 5
    ['escalation', 'HANDOFF'],
  ],
  TOOL_CALL: [
    ['tool_slow', 'FILLER'], // predicted duration > 500ms
    ['tool_result', 'SPEAKING'],
    ['first_clause', 'SPEAKING'],
    ['playout_complete', 'LISTENING'], // extension 5
    ['escalation', 'HANDOFF'],
  ],
  FILLER: [
    ['tool_result', 'SPEAKING'],
    ['first_clause', 'SPEAKING'],
    ['barge_in_confirmed', 'BARGE_IN'],
    ['playout_complete', 'LISTENING'], // extension 5
    ['escalation', 'HANDOFF'],
  ],
  SPEAKING: [
    ['playout_complete', 'LISTENING'],
    ['barge_in_confirmed', 'BARGE_IN'],
    ['tool_call', 'TOOL_CALL'], // model calls a tool mid-reply, after some audio
    ['escalation', 'HANDOFF'],
  ],
  BARGE_IN: [['context_truncated', 'LISTENING']],
  HOLD: [
    ['reprompt_played', 'LISTENING'],
    ['barge_in_confirmed', 'BARGE_IN'], // caller answers over the reprompt
    ['escalation', 'HANDOFF'],
  ],
  HANDOFF: [
    ['reverse_handoff', 'LISTENING'], // docs/03 §H: human hands back for wrap-up
    ['transfer_complete', 'ENDED'],
  ],
  ENDED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CallState,
    readonly to: CallState,
    readonly trigger: CallTrigger,
    readonly callId: string,
  ) {
    super(
      `[${callId}] illegal transition ${from} -> ${to} on "${trigger}". ` +
        `Legal from ${from}: ${
          TRANSITIONS[from].map(([t, s]) => `${t}->${s}`).join(', ') || '(terminal)'
        }`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export interface StateMachineOptions {
  readonly callId: string;
  readonly initial?: CallState;
  /** Milliseconds since call start. Injected so tests and the simulator control time. */
  readonly now: () => number;
  readonly onTransition?: (record: StateTransitionRecord) => void;
}

export class CallStateMachine {
  private current: CallState;
  private readonly log: StateTransitionRecord[] = [];

  constructor(private readonly opts: StateMachineOptions) {
    this.current = opts.initial ?? 'GREETING';
  }

  get state(): CallState {
    return this.current;
  }

  get history(): readonly StateTransitionRecord[] {
    return this.log;
  }

  is(...states: CallState[]): boolean {
    return states.includes(this.current);
  }

  /** Resolve a trigger to its target state, or undefined if it is not legal here. */
  target(trigger: CallTrigger): CallState | undefined {
    if (trigger === 'hangup') return 'ENDED'; // extension 4
    return TRANSITIONS[this.current].find(([t]) => t === trigger)?.[1];
  }

  can(trigger: CallTrigger): boolean {
    return this.target(trigger) !== undefined && this.current !== 'ENDED';
  }

  /**
   * Fire a trigger. Throws `InvalidTransitionError` on anything the table doesn't
   * allow — deliberately loud. A silent no-op here would surface later as a
   * duplicated audio stream or a stuck call, hours away from the actual cause.
   */
  fire(trigger: CallTrigger): CallState {
    const to = this.target(trigger);
    if (to === undefined || (this.current === 'ENDED' && trigger !== 'hangup')) {
      throw new InvalidTransitionError(this.current, to ?? this.current, trigger, this.opts.callId);
    }
    return this.commit(to, trigger);
  }

  /**
   * Idempotent variant for triggers that legitimately fire more than once —
   * `partial_transcript` arrives every ~100ms, and re-entering SPEAKING for the
   * second clause of the same reply is not a state change.
   */
  fireIfPossible(trigger: CallTrigger): CallState {
    return this.can(trigger) ? this.fire(trigger) : this.current;
  }

  private commit(to: CallState, trigger: CallTrigger): CallState {
    const record: StateTransitionRecord = {
      from: this.current,
      to,
      trigger,
      tMs: this.opts.now(),
    };
    this.current = to;
    this.log.push(record);
    this.opts.onTransition?.(record);
    return to;
  }
}
