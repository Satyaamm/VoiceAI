/**
 * Campaign service — CRUD, lifecycle, lead loading, progress.
 *
 * The lifecycle is a small explicit state machine rather than a free-form status
 * field, because "who paused this and when" is an audit question in an outbound
 * system. Dialing itself lives in `dialer.ts`; this service only decides whether a
 * campaign is *allowed* to be dialing.
 */

import { newId } from '../domain/ids.js';
import { require_, type WorkspaceScope } from '../domain/tenant.js';
import {
  campaignSchema,
  campaignScheduleSchema,
  leadSchema,
  pacingSchema,
  retryPolicySchema,
  type Campaign,
  type CampaignStats,
  type CampaignStatus,
  type CreateCampaignInput,
  type CreateLeadInput,
  type Lead,
  type UpdateCampaignInput,
} from '../domain/telephony-schemas.js';
import {
  CampaignStateError,
  type CampaignListOptions,
  type CampaignRepository,
  type LeadListOptions,
  type LeadRepository,
  type PhoneNumberRepository,
} from '../repositories/telephony-repository.js';
import { NotFoundError, type AgentRepository } from '../repositories/types.js';
import { UNDIALABLE_REPUTATION } from './number-service.js';

/**
 * Legal transitions. Anything absent is rejected — a campaign cannot go from
 * `stopped` back to `running`, because resuming a stopped campaign silently is
 * how leads get called twice.
 */
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['running', 'stopped'],
  running: ['paused', 'stopped', 'completed'],
  paused: ['running', 'stopped'],
  stopped: [],
  completed: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface CampaignProgress {
  campaignId: string;
  status: CampaignStatus;
  stats: CampaignStats;
  /** completed / totalLeads, 0–1. */
  completionRatio: number;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export class CampaignService {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly leads: LeadRepository,
    private readonly agents: AgentRepository,
    private readonly numbers: PhoneNumberRepository,
  ) {}

  // -- CRUD ----------------------------------------------------------------

  async list(scope: WorkspaceScope, opts?: CampaignListOptions) {
    require_(scope, 'workspace:read');
    return this.campaigns.list(scope, opts);
  }

  async get(scope: WorkspaceScope, campaignId: string): Promise<Campaign> {
    require_(scope, 'workspace:read');
    const campaign = await this.campaigns.get(scope, campaignId);
    if (!campaign) throw new NotFoundError('campaign', campaignId);
    return campaign;
  }

  async create(scope: WorkspaceScope, input: CreateCampaignInput): Promise<Campaign> {
    require_(scope, 'campaign:manage');

    const agent = await this.agents.get(scope, input.agentId);
    if (!agent) throw new NotFoundError('agent', input.agentId);

    const now = new Date().toISOString();
    const campaign = campaignSchema.parse({
      id: newId('campaign'),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      agentId: input.agentId,
      name: input.name,
      description: input.description ?? '',
      status: 'draft',
      callerNumberIds: input.callerNumberIds,
      pacing: pacingSchema.parse(input.pacing ?? {}),
      schedule: campaignScheduleSchema.parse(input.schedule ?? {}),
      retryPolicy: retryPolicySchema.parse(input.retryPolicy ?? {}),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      stoppedAt: null,
    } satisfies Record<string, unknown>);

    return this.campaigns.create(scope, campaign);
  }

  async update(
    scope: WorkspaceScope,
    campaignId: string,
    patch: UpdateCampaignInput,
  ): Promise<Campaign> {
    require_(scope, 'campaign:manage');
    const existing = await this.get(scope, campaignId);

    if (existing.status === 'stopped' || existing.status === 'completed') {
      throw new CampaignStateError(`cannot edit a ${existing.status} campaign`);
    }

    const merged: Partial<Campaign> = {};
    if (patch.name !== undefined) merged.name = patch.name;
    if (patch.description !== undefined) merged.description = patch.description;
    if (patch.callerNumberIds !== undefined) merged.callerNumberIds = patch.callerNumberIds;
    if (patch.agentId !== undefined) {
      const agent = await this.agents.get(scope, patch.agentId);
      if (!agent) throw new NotFoundError('agent', patch.agentId);
      merged.agentId = patch.agentId;
    }
    // Nested config merges rather than replaces.
    if (patch.pacing) merged.pacing = pacingSchema.parse({ ...existing.pacing, ...patch.pacing });
    if (patch.schedule) {
      merged.schedule = campaignScheduleSchema.parse({ ...existing.schedule, ...patch.schedule });
    }
    if (patch.retryPolicy) {
      merged.retryPolicy = retryPolicySchema.parse({
        ...existing.retryPolicy,
        ...patch.retryPolicy,
      });
    }

    return this.campaigns.update(scope, campaignId, merged);
  }

  async delete(scope: WorkspaceScope, campaignId: string): Promise<void> {
    require_(scope, 'campaign:manage');
    const campaign = await this.get(scope, campaignId);
    if (campaign.status === 'running') {
      throw new CampaignStateError('stop the campaign before deleting it');
    }
    await this.campaigns.delete(scope, campaignId);
  }

  // -- Leads ---------------------------------------------------------------

  async addLeads(
    scope: WorkspaceScope,
    campaignId: string,
    inputs: CreateLeadInput[],
  ): Promise<Lead[]> {
    require_(scope, 'campaign:manage');
    await this.get(scope, campaignId);

    const now = new Date().toISOString();
    const rows = inputs.map((input) =>
      leadSchema.parse({
        id: newId('lead'),
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        campaignId,
        e164: input.e164,
        country: input.country.toUpperCase(),
        state: input.state?.toUpperCase(),
        timezone: input.timezone ?? null,
        isMobile: input.isMobile ?? false,
        displayName: input.displayName,
        attemptCount: 0,
        lastOutcome: 'none',
        lastAttemptAt: null,
        nextAttemptAt: null,
        lifecycle: 'pending',
        consentProof: input.consentProof ?? null,
        onDncList: false,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      } satisfies Record<string, unknown>),
    );

    return this.leads.createMany(scope, rows);
  }

  async listLeads(scope: WorkspaceScope, campaignId: string, opts?: LeadListOptions) {
    require_(scope, 'workspace:read');
    await this.get(scope, campaignId);
    return this.leads.list(scope, campaignId, opts);
  }

  // -- Lifecycle -----------------------------------------------------------

  /**
   * Start dialing. Preconditions are checked here rather than at dispatch so the
   * failure is visible in the UI immediately, not as a stream of blocked dials.
   */
  async start(scope: WorkspaceScope, campaignId: string): Promise<Campaign> {
    require_(scope, 'campaign:manage');
    const campaign = await this.get(scope, campaignId);
    this.assertTransition(campaign, 'running');

    const agent = await this.agents.get(scope, campaign.agentId);
    if (!agent) throw new NotFoundError('agent', campaign.agentId);
    if (agent.status !== 'live') {
      throw new CampaignStateError(
        `agent ${agent.id} is ${agent.status}; publish it before starting the campaign`,
      );
    }

    if (campaign.callerNumberIds.length === 0) {
      throw new CampaignStateError('campaign has no caller numbers assigned');
    }

    // Per docs/03 §I: a campaign whose entire number pool is flagged must not run.
    // Dialing from a flagged number burns answer rate and the number itself.
    let dialable = 0;
    for (const id of campaign.callerNumberIds) {
      const number = await this.numbers.get(scope, id);
      if (!number) throw new NotFoundError('phone number', id);
      if (number.status === 'active' && !UNDIALABLE_REPUTATION.has(number.reputation.status)) {
        dialable += 1;
      }
    }
    if (dialable === 0) {
      throw new CampaignStateError(
        'every caller number is inactive or flagged for spam; rotate the number pool before starting',
      );
    }

    return this.campaigns.update(scope, campaignId, {
      status: 'running',
      startedAt: campaign.startedAt ?? new Date().toISOString(),
    });
  }

  async pause(scope: WorkspaceScope, campaignId: string): Promise<Campaign> {
    require_(scope, 'campaign:manage');
    const campaign = await this.get(scope, campaignId);
    this.assertTransition(campaign, 'paused');
    return this.campaigns.update(scope, campaignId, { status: 'paused' });
  }

  /** Terminal. In-flight calls finish; nothing new is dispatched. */
  async stop(scope: WorkspaceScope, campaignId: string): Promise<Campaign> {
    require_(scope, 'campaign:manage');
    const campaign = await this.get(scope, campaignId);
    this.assertTransition(campaign, 'stopped');
    return this.campaigns.update(scope, campaignId, {
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
    });
  }

  // -- Progress ------------------------------------------------------------

  async progress(scope: WorkspaceScope, campaignId: string): Promise<CampaignProgress> {
    require_(scope, 'workspace:read');
    const campaign = await this.get(scope, campaignId);
    const counts = await this.leads.countsByLifecycle(scope, campaignId);

    const totalLeads = Object.values(counts).reduce((a, b) => a + b, 0);
    const stats: CampaignStats = {
      totalLeads,
      pending: counts.pending,
      inFlight: counts.in_flight,
      completed: counts.completed,
      // `suppressed` = blocked by compliance or DNC. Surfaced separately from
      // `exhausted` because it's a very different conversation with the customer.
      blocked: counts.suppressed,
      exhausted: counts.exhausted,
      dialsPlaced: 0,
    };

    // Sum of attempts across leads is the honest "dials placed" figure; the
    // production version reads it from the call table.
    const page = await this.leads.list(scope, campaignId, { pageSize: 10_000 });
    stats.dialsPlaced = page.items.reduce((sum, l) => sum + l.attemptCount, 0);

    const upcoming = page.items
      .map((l) => l.nextAttemptAt)
      .filter((t): t is string => typeof t === 'string')
      .sort();

    return {
      campaignId,
      status: campaign.status,
      stats,
      completionRatio: totalLeads === 0 ? 0 : stats.completed / totalLeads,
      nextAttemptAt: upcoming[0] ?? null,
      updatedAt: campaign.updatedAt,
    };
  }

  // -------------------------------------------------------------------------

  private assertTransition(campaign: Campaign, to: CampaignStatus): void {
    if (!canTransition(campaign.status, to)) {
      throw new CampaignStateError(
        `cannot move campaign from ${campaign.status} to ${to}`,
      );
    }
  }
}
