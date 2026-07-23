/**
 * Telephony repository interfaces.
 *
 * Same rule as `types.ts`: every method takes a scope FIRST. There is no
 * `findByE164(number)` without a scope — a lead's phone number is PII and a
 * cross-tenant lookup on it must be a compile error, not a code-review catch.
 *
 * The audit repository is deliberately append-only: no `update`, no `delete`.
 * docs/03 7.5 — an audit trail you can edit is not an audit trail.
 */

import type { TenantScope, WorkspaceScope } from '../domain/tenant.js';
import type { Campaign, Lead, PhoneNumber } from '../domain/telephony-schemas.js';
import type { ListOptions, Page } from './types.js';

export interface PhoneNumberListOptions extends ListOptions {
  country?: string;
  assignedAgentId?: string;
  status?: PhoneNumber['status'];
}

export interface PhoneNumberRepository {
  list(scope: WorkspaceScope, opts?: PhoneNumberListOptions): Promise<Page<PhoneNumber>>;
  get(scope: WorkspaceScope, numberId: string): Promise<PhoneNumber | null>;
  /** Scoped lookup by E.164 — used to prevent double-purchase within a workspace. */
  findByE164(scope: WorkspaceScope, e164: string): Promise<PhoneNumber | null>;
  /**
   * Org-wide uniqueness check. Deliberately takes a TenantScope, not a bare string:
   * a number can only be held once across the whole organization.
   */
  existsInOrg(scope: TenantScope, e164: string): Promise<boolean>;
  create(scope: WorkspaceScope, number: PhoneNumber): Promise<PhoneNumber>;
  update(scope: WorkspaceScope, numberId: string, patch: Partial<PhoneNumber>): Promise<PhoneNumber>;
  delete(scope: WorkspaceScope, numberId: string): Promise<void>;
}

export interface CampaignListOptions extends ListOptions {
  status?: Campaign['status'];
  agentId?: string;
}

export interface CampaignRepository {
  list(scope: WorkspaceScope, opts?: CampaignListOptions): Promise<Page<Campaign>>;
  get(scope: WorkspaceScope, campaignId: string): Promise<Campaign | null>;
  create(scope: WorkspaceScope, campaign: Campaign): Promise<Campaign>;
  update(scope: WorkspaceScope, campaignId: string, patch: Partial<Campaign>): Promise<Campaign>;
  delete(scope: WorkspaceScope, campaignId: string): Promise<void>;
}

export interface LeadListOptions extends ListOptions {
  lifecycle?: Lead['lifecycle'];
}

export interface LeadRepository {
  list(scope: WorkspaceScope, campaignId: string, opts?: LeadListOptions): Promise<Page<Lead>>;
  get(scope: WorkspaceScope, leadId: string): Promise<Lead | null>;
  create(scope: WorkspaceScope, lead: Lead): Promise<Lead>;
  createMany(scope: WorkspaceScope, leads: Lead[]): Promise<Lead[]>;
  update(scope: WorkspaceScope, leadId: string, patch: Partial<Lead>): Promise<Lead>;
  /**
   * Leads eligible for a dial attempt right now: pending or retry_scheduled with
   * `nextAttemptAt` in the past. Ordered oldest-first so nobody starves.
   */
  claimDueLeads(
    scope: WorkspaceScope,
    campaignId: string,
    nowIso: string,
    limit: number,
  ): Promise<Lead[]>;
  /** Aggregate counts by lifecycle — powers GET /v1/campaigns/:id/progress. */
  countsByLifecycle(
    scope: WorkspaceScope,
    campaignId: string,
  ): Promise<Record<Lead['lifecycle'], number>>;
}

// ---------------------------------------------------------------------------
// Dispatch audit — append only
// ---------------------------------------------------------------------------

/**
 * One immutable row per dispatch DECISION, allowed or blocked (docs/03 7.5).
 *
 * This is the artifact produced under subpoena in a TCPA matter, so it records the
 * inputs to the decision as well as the outcome — the compliance profile can change
 * tomorrow and this row must still explain why we dialed at 19:04 local time.
 */
export interface DispatchAuditEntry {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly campaignId: string | null;
  readonly leadId: string | null;
  readonly decidedAt: string;
  readonly decidedBy: string;
  /** E.164 of the callee. Redacted by the retention job, never by the writer. */
  readonly destination: string;
  readonly destinationCountry: string;
  readonly fromNumberId: string | null;
  readonly trunkId: string | null;
  readonly allowed: boolean;
  readonly reason: string;
  /** Which rule blocked, or the full chain trace when allowed. */
  readonly rulesApplied: ReadonlyArray<{ key: string; action: string; reason: string }>;
  /** Callee local time the calling-window rule actually evaluated. */
  readonly calleeLocalTime: { readonly dayOfWeek: number; readonly hour: number };
  readonly attemptNumber: number;
  readonly hadConsentProof: boolean;
  readonly consentProofRef: string | null;
  /** Snapshot of the profile fields that mattered, for later reconstruction. */
  readonly profileSnapshot: {
    readonly jurisdictions: readonly string[];
    readonly requireConsentProof: boolean;
    readonly maxAttemptsPerLead: number;
    readonly consentModel: string;
  };
}

export interface DispatchAuditRepository {
  /** Append only. There is intentionally no update or delete. */
  append(entry: DispatchAuditEntry): Promise<DispatchAuditEntry>;
  list(
    scope: WorkspaceScope,
    filter?: { campaignId?: string; leadId?: string; allowed?: boolean },
    opts?: ListOptions,
  ): Promise<Page<DispatchAuditEntry>>;
}

export class LocalPresenceRequiredError extends Error {
  readonly code = 'local_presence_required';
  constructor(
    readonly country: string,
    message: string,
    readonly requirements: readonly string[],
  ) {
    super(message);
    this.name = 'LocalPresenceRequiredError';
  }
}

export class CampaignStateError extends Error {
  readonly code = 'invalid_campaign_state';
  constructor(message: string) {
    super(message);
    this.name = 'CampaignStateError';
  }
}
