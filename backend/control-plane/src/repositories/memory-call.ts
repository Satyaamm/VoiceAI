/**
 * In-memory call and trace repositories.
 *
 * Same contract as the Postgres/ClickHouse implementations that replace them, and
 * the same discipline: every read filters on `scope.orgId` AND `scope.workspaceId`
 * before anything is returned.
 */

import type { CallListFilters, CallRepository, TraceRepository } from './call-repository.js';
import type { ListOptions, Page } from './types.js';
import { NotFoundError } from './types.js';
import type { Call, CallTrace } from '../domain/call-schemas.js';
import type { WorkspaceScope } from '../domain/tenant.js';

function paginate<T>(items: T[], opts: ListOptions = {}): Page<T> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

function matches(search: string | undefined, ...fields: string[]): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(q));
}

export class MemoryCallRepository implements CallRepository {
  constructor(private readonly calls = new Map<string, Call>()) {}

  private scoped(scope: WorkspaceScope): Call[] {
    return [...this.calls.values()].filter(
      (c) => c.orgId === scope.orgId && c.workspaceId === scope.workspaceId,
    );
  }

  async list(scope: WorkspaceScope, opts: CallListFilters = {}) {
    const items = this.scoped(scope)
      .filter((c) => (opts.agentId ? c.agentId === opts.agentId : true))
      .filter((c) => (opts.outcome ? c.outcome === opts.outcome : true))
      .filter((c) => (opts.status ? c.status === opts.status : true))
      .filter((c) => (opts.minLatencyMs === undefined ? true : c.p95LatencyMs >= opts.minLatencyMs))
      .filter((c) => matches(opts.search, c.id, c.agentName, c.fromNumber, c.toNumber))
      // Newest first — the call log is a debugging queue, not an archive.
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return paginate(items, opts);
  }

  async get(scope: WorkspaceScope, callId: string) {
    const call = this.calls.get(callId);
    return call && call.orgId === scope.orgId && call.workspaceId === scope.workspaceId
      ? call
      : null;
  }

  async create(scope: WorkspaceScope, call: Call) {
    const row = { ...call, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.calls.set(row.id, row);
    return row;
  }

  async update(scope: WorkspaceScope, callId: string, patch: Partial<Call>) {
    const existing = await this.get(scope, callId);
    if (!existing) throw new NotFoundError('call', callId);
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
    };
    this.calls.set(next.id, next);
    return next;
  }
}

export class MemoryTraceRepository implements TraceRepository {
  constructor(private readonly traces = new Map<string, CallTrace>()) {}

  async get(scope: WorkspaceScope, callId: string) {
    const trace = this.traces.get(callId);
    // The tenancy check reads the embedded call, so a trace can never be served
    // through a workspace that did not produce it.
    return trace &&
      trace.call.orgId === scope.orgId &&
      trace.call.workspaceId === scope.workspaceId
      ? trace
      : null;
  }

  async save(scope: WorkspaceScope, trace: CallTrace) {
    const row: CallTrace = {
      ...trace,
      call: { ...trace.call, orgId: scope.orgId, workspaceId: scope.workspaceId },
    };
    this.traces.set(row.call.id, row);
    return row;
  }

  async delete(scope: WorkspaceScope, callId: string) {
    const existing = await this.get(scope, callId);
    if (!existing) throw new NotFoundError('trace', callId);
    this.traces.delete(callId);
  }
}
