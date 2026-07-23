/**
 * In-memory telephony repositories.
 *
 * Phase 1 storage, same contract as the Postgres implementations. Mirrors
 * `memory.ts`: every read filters on `scope.orgId` AND `scope.workspaceId`, which
 * is the behaviour row-level security enforces again in Postgres.
 */

import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';
import type { Campaign, Lead, PhoneNumber } from '../domain/telephony-schemas.js';
import type {
  CampaignListOptions,
  CampaignRepository,
  DispatchAuditEntry,
  DispatchAuditRepository,
  LeadListOptions,
  LeadRepository,
  PhoneNumberListOptions,
  PhoneNumberRepository,
} from './telephony-repository.js';
import { ConflictError, NotFoundError, type ListOptions, type Page } from './types.js';

function paginate<T>(items: T[], opts: ListOptions = {}): Page<T> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

function matches(search: string | undefined, ...fields: Array<string | undefined>): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

export class MemoryPhoneNumberRepository implements PhoneNumberRepository {
  constructor(private readonly numbers = new Map<string, PhoneNumber>()) {}

  private scoped(scope: WorkspaceScope): PhoneNumber[] {
    return [...this.numbers.values()].filter(
      (n) => n.orgId === scope.orgId && n.workspaceId === scope.workspaceId,
    );
  }

  async list(scope: WorkspaceScope, opts: PhoneNumberListOptions = {}) {
    const items = this.scoped(scope)
      .filter((n) => (opts.country ? n.country === opts.country.toUpperCase() : true))
      .filter((n) => (opts.status ? n.status === opts.status : n.status !== 'released'))
      .filter((n) =>
        opts.assignedAgentId ? n.assignedAgentId === opts.assignedAgentId : true,
      )
      .filter((n) => matches(opts.search, n.e164, n.cnamLabel, n.carrier))
      .sort((a, b) => a.e164.localeCompare(b.e164));
    return paginate(items, opts);
  }

  async get(scope: WorkspaceScope, numberId: string) {
    const n = this.numbers.get(numberId);
    return n && n.orgId === scope.orgId && n.workspaceId === scope.workspaceId ? n : null;
  }

  async findByE164(scope: WorkspaceScope, e164: string) {
    return this.scoped(scope).find((n) => n.e164 === e164 && n.status !== 'released') ?? null;
  }

  async existsInOrg(scope: TenantScope, e164: string) {
    return [...this.numbers.values()].some(
      (n) => n.orgId === scope.orgId && n.e164 === e164 && n.status !== 'released',
    );
  }

  async create(scope: WorkspaceScope, number: PhoneNumber) {
    if (await this.existsInOrg(scope, number.e164)) {
      throw new ConflictError(`number already held by this organization: ${number.e164}`);
    }
    const row = { ...number, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.numbers.set(row.id, row);
    return row;
  }

  async update(scope: WorkspaceScope, numberId: string, patch: Partial<PhoneNumber>) {
    const existing = await this.get(scope, numberId);
    if (!existing) throw new NotFoundError('phone number', numberId);
    const next: PhoneNumber = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
      e164: existing.e164,
    };
    this.numbers.set(next.id, next);
    return next;
  }

  async delete(scope: WorkspaceScope, numberId: string) {
    const existing = await this.get(scope, numberId);
    if (!existing) throw new NotFoundError('phone number', numberId);
    // Soft delete: call records reference this number and must stay resolvable.
    this.numbers.set(numberId, {
      ...existing,
      status: 'released',
      assignedAgentId: null,
      releasedAt: new Date().toISOString(),
    });
  }
}

export class MemoryCampaignRepository implements CampaignRepository {
  constructor(private readonly campaigns = new Map<string, Campaign>()) {}

  private scoped(scope: WorkspaceScope): Campaign[] {
    return [...this.campaigns.values()].filter(
      (c) => c.orgId === scope.orgId && c.workspaceId === scope.workspaceId,
    );
  }

  async list(scope: WorkspaceScope, opts: CampaignListOptions = {}) {
    const items = this.scoped(scope)
      .filter((c) => (opts.status ? c.status === opts.status : true))
      .filter((c) => (opts.agentId ? c.agentId === opts.agentId : true))
      .filter((c) => matches(opts.search, c.name, c.description))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return paginate(items, opts);
  }

  async get(scope: WorkspaceScope, campaignId: string) {
    const c = this.campaigns.get(campaignId);
    return c && c.orgId === scope.orgId && c.workspaceId === scope.workspaceId ? c : null;
  }

  async create(scope: WorkspaceScope, campaign: Campaign) {
    const row = { ...campaign, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.campaigns.set(row.id, row);
    return row;
  }

  async update(scope: WorkspaceScope, campaignId: string, patch: Partial<Campaign>) {
    const existing = await this.get(scope, campaignId);
    if (!existing) throw new NotFoundError('campaign', campaignId);
    const next: Campaign = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.campaigns.set(next.id, next);
    return next;
  }

  async delete(scope: WorkspaceScope, campaignId: string) {
    const existing = await this.get(scope, campaignId);
    if (!existing) throw new NotFoundError('campaign', campaignId);
    this.campaigns.delete(campaignId);
  }
}

const EMPTY_COUNTS: Record<Lead['lifecycle'], number> = {
  pending: 0,
  in_flight: 0,
  retry_scheduled: 0,
  completed: 0,
  exhausted: 0,
  suppressed: 0,
};

export class MemoryLeadRepository implements LeadRepository {
  constructor(private readonly leads = new Map<string, Lead>()) {}

  private scoped(scope: WorkspaceScope, campaignId?: string): Lead[] {
    return [...this.leads.values()].filter(
      (l) =>
        l.orgId === scope.orgId &&
        l.workspaceId === scope.workspaceId &&
        (campaignId ? l.campaignId === campaignId : true),
    );
  }

  async list(scope: WorkspaceScope, campaignId: string, opts: LeadListOptions = {}) {
    const items = this.scoped(scope, campaignId)
      .filter((l) => (opts.lifecycle ? l.lifecycle === opts.lifecycle : true))
      .filter((l) => matches(opts.search, l.e164, l.displayName))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return paginate(items, opts);
  }

  async get(scope: WorkspaceScope, leadId: string) {
    const l = this.leads.get(leadId);
    return l && l.orgId === scope.orgId && l.workspaceId === scope.workspaceId ? l : null;
  }

  async create(scope: WorkspaceScope, lead: Lead) {
    const row = { ...lead, orgId: scope.orgId, workspaceId: scope.workspaceId };
    this.leads.set(row.id, row);
    return row;
  }

  async createMany(scope: WorkspaceScope, leads: Lead[]) {
    const out: Lead[] = [];
    for (const lead of leads) out.push(await this.create(scope, lead));
    return out;
  }

  async update(scope: WorkspaceScope, leadId: string, patch: Partial<Lead>) {
    const existing = await this.get(scope, leadId);
    if (!existing) throw new NotFoundError('lead', leadId);
    const next: Lead = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      workspaceId: existing.workspaceId,
      campaignId: existing.campaignId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.leads.set(next.id, next);
    return next;
  }

  async claimDueLeads(scope: WorkspaceScope, campaignId: string, nowIso: string, limit: number) {
    return this.scoped(scope, campaignId)
      .filter((l) => l.lifecycle === 'pending' || l.lifecycle === 'retry_scheduled')
      .filter((l) => !l.nextAttemptAt || l.nextAttemptAt <= nowIso)
      .sort((a, b) => (a.nextAttemptAt ?? a.createdAt).localeCompare(b.nextAttemptAt ?? b.createdAt))
      .slice(0, limit);
  }

  async countsByLifecycle(scope: WorkspaceScope, campaignId: string) {
    const counts: Record<Lead['lifecycle'], number> = { ...EMPTY_COUNTS };
    for (const lead of this.scoped(scope, campaignId)) {
      counts[lead.lifecycle] += 1;
    }
    return counts;
  }
}

export class MemoryDispatchAuditRepository implements DispatchAuditRepository {
  /** Array, not Map — append-only means there is nothing to key by for mutation. */
  constructor(private readonly entries: DispatchAuditEntry[] = []) {}

  async append(entry: DispatchAuditEntry) {
    // Frozen at the boundary so a later holder of the reference cannot rewrite history.
    const frozen = Object.freeze({ ...entry });
    this.entries.push(frozen);
    return frozen;
  }

  async list(
    scope: WorkspaceScope,
    filter: { campaignId?: string; leadId?: string; allowed?: boolean } = {},
    opts: ListOptions = {},
  ) {
    const items = this.entries
      .filter((e) => e.orgId === scope.orgId && e.workspaceId === scope.workspaceId)
      .filter((e) => (filter.campaignId ? e.campaignId === filter.campaignId : true))
      .filter((e) => (filter.leadId ? e.leadId === filter.leadId : true))
      .filter((e) => (filter.allowed === undefined ? true : e.allowed === filter.allowed))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    return paginate(items, opts);
  }
}
