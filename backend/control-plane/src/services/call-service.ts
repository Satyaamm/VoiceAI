/**
 * Call service — the read side of the call log and the trace viewer.
 *
 * The one rule that is not obvious from the types: `call:read_pii` gates the
 * CONTENT of a trace, not access to it. docs/03 7.1 — card numbers and SSNs end up
 * in transcripts, and the analyst/viewer roles deliberately lack `call:read_pii`
 * (see `domain/tenant.ts`), so they get the full waterfall with the PII masked.
 * That is what makes it safe to hand trace access to QA and BPO staff, which is
 * exactly the audience the trace viewer is built for.
 *
 * Masking happens on read, on the way out. Storage-side redaction is the streaming
 * pipeline's job (docs/03 §E); this is the second line of defence, and it applies
 * even to traces written before a workspace turned redaction on.
 */

import { can, require_, type WorkspaceScope } from '../domain/tenant.js';
import type { Call, CallTrace, TraceEvent, TraceToolCall, Turn } from '../domain/call-schemas.js';
import type { CallListFilters, CallRepository, TraceRepository } from '../repositories/call-repository.js';
import { NotFoundError, type Page } from '../repositories/types.js';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]';

/**
 * Ordered deliberately: card-like runs first (they contain separators that the
 * plain digit rule would only partially match), then emails, then any remaining
 * run of 6+ digits — order numbers, account numbers, SSNs, DOBs.
 *
 * Not covered here: digits spoken as words ("four two seven three"). That needs the
 * streaming redactor's inverse-text-normalisation pass and cannot be done with a
 * regex over a finalised transcript.
 */
const REDACTION_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d(?:[ -]?\d){12,18}\b/g, label: 'card' },
  { pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, label: 'email' },
  { pattern: /\d{6,}/g, label: 'digits' },
];

/** Exported for tests and for the trace recorder's optional at-write redaction. */
export function maskPii(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    // Reset lastIndex — these are module-level /g regexes reused across calls.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, REDACTED);
  }
  return out;
}

/**
 * Tool payloads carry the same PII as transcripts — a `lookup_order` request is
 * usually the card or account number the caller just read out. Masking the
 * serialised form covers arbitrary nesting without walking unknown shapes.
 */
function maskUnknown(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(maskPii(JSON.stringify(value))) as unknown;
  } catch {
    // Non-serialisable payload: drop it rather than risk leaking it.
    return REDACTED;
  }
}

function maskToolCall(tool: TraceToolCall): TraceToolCall {
  return { ...tool, request: maskUnknown(tool.request), response: maskUnknown(tool.response) };
}

function maskTurn(turn: Turn): Turn {
  const masked: Turn = { ...turn, transcript: maskPii(turn.transcript) };
  if (turn.toolCalls) masked.toolCalls = turn.toolCalls.map(maskToolCall);
  return masked;
}

/** Only `text` can carry transcript fragments; `value` is always a metric. */
function maskEvent(event: TraceEvent): TraceEvent {
  return event.text === undefined ? event : { ...event, text: maskPii(event.text) };
}

export function maskTrace(trace: CallTrace): CallTrace {
  return {
    ...trace,
    turns: trace.turns.map(maskTurn),
    events: trace.events.map(maskEvent),
  };
}

// ---------------------------------------------------------------------------

export class CallService {
  constructor(
    private readonly calls: CallRepository,
    private readonly traces: TraceRepository,
  ) {}

  async list(scope: WorkspaceScope, opts?: CallListFilters): Promise<Page<Call>> {
    require_(scope, 'call:read');
    // Call rows hold no transcript text, so there is nothing to mask here. Phone
    // numbers stay visible: without them the call log cannot be reconciled with a
    // customer's own records, which is the whole point of the screen.
    return this.calls.list(scope, opts);
  }

  async get(scope: WorkspaceScope, callId: string): Promise<Call> {
    require_(scope, 'call:read');
    const call = await this.calls.get(scope, callId);
    if (!call) throw new NotFoundError('call', callId);
    return call;
  }

  async getTrace(scope: WorkspaceScope, callId: string): Promise<CallTrace> {
    require_(scope, 'call:read');
    const trace = await this.traces.get(scope, callId);
    if (!trace) throw new NotFoundError('trace', callId);
    return can(scope, 'call:read_pii') ? trace : maskTrace(trace);
  }

  /**
   * Ingest a completed trace: the seam the trace recorder and the fixture
   * generator both write through. Requires `call:read_pii` because an unmasked
   * trace goes in — a caller that may not read PII may certainly not author it.
   */
  async ingest(scope: WorkspaceScope, trace: CallTrace): Promise<CallTrace> {
    require_(scope, 'call:read_pii');
    await this.calls.create(scope, trace.call);
    return this.traces.save(scope, trace);
  }
}
