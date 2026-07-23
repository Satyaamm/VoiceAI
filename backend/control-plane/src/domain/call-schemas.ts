/**
 * Zod schemas for calls and traces — the runtime mirror of the `Call`, `Turn`,
 * `LatencyBreakdown`, `TraceToolCall`, `TraceEvent` and `CallTrace` types in
 * `frontend/src/lib/contract.ts`.
 *
 * Kept in its own module rather than appended to `domain/schemas.ts` because the
 * trace surface is large, changes on its own cadence, and is consumed by exactly
 * one screen (docs/07 §call trace viewer) plus the trace recorder.
 *
 * The field set is deliberately identical to the contract — the dashboard's
 * waterfall is drawn straight from these objects, so an extra or missing field
 * here is a rendering bug there.
 */

import { z } from 'zod';
import { modeSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

export const callStatusSchema = z.enum(['ringing', 'active', 'completed', 'failed', 'no_answer']);
export const callDirectionSchema = z.enum(['inbound', 'outbound']);
export const callOutcomeSchema = z.enum([
  'resolved',
  'escalated',
  'abandoned',
  'voicemail',
  'unknown',
]);

export const callSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  /** Denormalised so the call log renders without an agent join. */
  agentName: z.string(),
  mode: modeSchema,
  direction: callDirectionSchema,
  status: callStatusSchema,
  outcome: callOutcomeSchema,
  fromNumber: z.string(),
  toNumber: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationSec: z.number().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  /** Median end-of-speech -> first-audio across this call's agent turns. */
  medianLatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  bargeInCount: z.number().int().nonnegative(),
  /** Which immutable agent version actually ran (docs/03 6.7). */
  agentVersion: z.number().int().min(1),
  complianceFlags: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export const turnRoleSchema = z.enum(['caller', 'agent']);

/**
 * The latency decomposition from docs/01 §1. `totalMs` is the number the product
 * is sold on; the five components below it must sum to it, otherwise the
 * waterfall bars in the trace viewer do not add up to the headline figure.
 */
export const latencyBreakdownSchema = z
  .object({
    totalMs: z.number().nonnegative(),
    endpointingMs: z.number().nonnegative(),
    sttFinalizeMs: z.number().nonnegative(),
    llmTtftMs: z.number().nonnegative(),
    ttsTtfbMs: z.number().nonnegative(),
    networkMs: z.number().nonnegative(),
    prefixCacheHit: z.boolean(),
    promptTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  })
  .refine((l) => l.cachedTokens <= l.promptTokens, {
    message: 'cachedTokens cannot exceed promptTokens',
    path: ['cachedTokens'],
  });

export const traceToolCallSchema = z.object({
  name: z.string(),
  /** Milliseconds since call start, same clock as every lane. */
  startMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['ok', 'timeout', 'error']),
  request: z.unknown(),
  response: z.unknown(),
});

export const traceGuardrailSchema = z.object({
  key: z.string(),
  action: z.string(),
  reason: z.string(),
});

export const turnSchema = z.object({
  index: z.number().int().nonnegative(),
  role: turnRoleSchema,
  transcript: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  latency: latencyBreakdownSchema.optional(),
  interrupted: z.boolean().optional(),
  /**
   * docs/02 §barge-in: how much of the generated reply was actually in the
   * caller's ear. Strictly less than the transcript length on a real barge-in —
   * this is the bookkeeping the trace viewer makes visible.
   */
  playedOutChars: z.number().int().nonnegative().optional(),
  toolCalls: z.array(traceToolCallSchema).optional(),
  guardrails: z.array(traceGuardrailSchema).optional(),
});

export const traceLaneSchema = z.enum([
  'vad',
  'endpoint',
  'stt',
  'llm',
  'tts',
  'tool',
  'guardrail',
  'bargein',
]);

export const traceEventSchema = z.object({
  /** Always relative to call start — no server-side clock reconciliation. */
  tMs: z.number().nonnegative(),
  lane: traceLaneSchema,
  type: z.string(),
  value: z.number().optional(),
  text: z.string().optional(),
});

export const waveformSchema = z.object({
  caller: z.array(z.number().min(0).max(1)),
  agent: z.array(z.number().min(0).max(1)),
  binMs: z.number().int().positive(),
});

export const callTraceSchema = z.object({
  call: callSchema,
  turns: z.array(turnSchema),
  events: z.array(traceEventSchema),
  waveform: waveformSchema,
});

// ---------------------------------------------------------------------------
// Read DTO — the call log's query string
// ---------------------------------------------------------------------------

/**
 * docs/07 §Analyze: the call log is filtered by outcome, agent and latency, and
 * "filter to turns over 600ms and jump to the outliers" is the debugging loop the
 * trace viewer is built around. `minLatencyMs` filters on p95, not median, because
 * the outlier is what you are hunting.
 */
export const listCallsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().max(200).optional(),
  agentId: z.string().optional(),
  outcome: callOutcomeSchema.optional(),
  status: callStatusSchema.optional(),
  minLatencyMs: z.coerce.number().nonnegative().optional(),
});

// ---------------------------------------------------------------------------

export type Call = z.infer<typeof callSchema>;
export type CallStatus = z.infer<typeof callStatusSchema>;
export type CallDirection = z.infer<typeof callDirectionSchema>;
export type CallOutcome = z.infer<typeof callOutcomeSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type TurnRole = z.infer<typeof turnRoleSchema>;
export type LatencyBreakdown = z.infer<typeof latencyBreakdownSchema>;
export type TraceToolCall = z.infer<typeof traceToolCallSchema>;
export type TraceLane = z.infer<typeof traceLaneSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type CallTrace = z.infer<typeof callTraceSchema>;
export type ListCallsQuery = z.infer<typeof listCallsQuery>;
