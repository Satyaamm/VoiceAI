/**
 * Call and trace repository interfaces.
 *
 * Same rule as `types.ts`: the scope is always the first argument, and calls are
 * workspace-scoped rather than org-scoped because a call always belongs to exactly
 * one workspace (docs/10 §Scoping rules).
 *
 * Traces are split from calls on purpose. A call row is small and queried in bulk;
 * a trace is ~30k events for a 10-minute call and is fetched one at a time
 * (docs/07 §trace viewer). In production those are two different stores — Postgres
 * for calls, ClickHouse for traces — and this split is what lets the ClickHouse
 * implementation land without touching CallRepository.
 */

import type { WorkspaceScope } from '../domain/tenant.js';
import type { Call, CallOutcome, CallStatus, CallTrace } from '../domain/call-schemas.js';
import type { ListOptions, Page } from './types.js';

export interface CallListFilters extends ListOptions {
  agentId?: string;
  outcome?: CallOutcome;
  status?: CallStatus;
  /** Keeps only calls whose p95 turn latency is at or above this — the outlier hunt. */
  minLatencyMs?: number;
}

export interface CallRepository {
  list(scope: WorkspaceScope, opts?: CallListFilters): Promise<Page<Call>>;
  get(scope: WorkspaceScope, callId: string): Promise<Call | null>;
  create(scope: WorkspaceScope, call: Call): Promise<Call>;
  /** Live calls mutate as they progress: status, duration, turn count, cost. */
  update(scope: WorkspaceScope, callId: string, patch: Partial<Call>): Promise<Call>;
}

export interface TraceRepository {
  get(scope: WorkspaceScope, callId: string): Promise<CallTrace | null>;
  /** Written once when the call ends; overwritten only by a replay/backfill. */
  save(scope: WorkspaceScope, trace: CallTrace): Promise<CallTrace>;
  /** Retention enforcement (docs/13 §2 `retentionDays`) and right-to-erasure. */
  delete(scope: WorkspaceScope, callId: string): Promise<void>;
}
