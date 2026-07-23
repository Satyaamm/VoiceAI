/**
 * Drizzle schema — the physical shape of the control plane.
 *
 * Three rules run through every table here:
 *
 * 1. **Ids are prefixed strings** (`org_7fk2…`, `ws_9m3q…`), not uuid and not serial.
 *    See `src/domain/ids.ts`. They are `text` columns: readable in logs, safe in URLs,
 *    and they leak nothing about row counts. Generation stays in the application so
 *    the prefix and the entity kind can never drift apart.
 *
 * 2. **Every operational table carries `org_id` and `workspace_id`.** Not because the
 *    ORM needs it — a join could derive it — but because RLS needs a column it can
 *    policy on without a subquery, and because a denormalised tenant key makes the
 *    "which tenant does this row belong to" question answerable from the row alone.
 *    docs/10 §Scoping rules, rule 2.
 *
 * 3. **Timestamps are `timestamptz`, always UTC.** Postgres stores an absolute instant;
 *    the wire format for the domain is an ISO-8601 string. Drizzle hands us `Date`
 *    (mode: 'date'), and the repositories `.toISOString()` on the way out — see the
 *    note in `src/db/README.md` about why we do not use `mode: 'string'`.
 *
 * Nested value objects (compliance profile, spend caps, voice/pipeline config, tool
 * definitions, phone-number value objects) live in `jsonb` and are `$type<>`d against
 * the Zod inferred types. They are configuration read as a unit, never queried
 * field-by-field, and giving each of them a table would buy joins and nothing else.
 */

import {
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type {
  ComplianceProfile,
  SpendCaps,
  Region,
  Mode,
  OrgRole,
  WorkspaceRole,
} from '../domain/schemas.js';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

/** timestamptz, UTC, non-null, defaulted server-side. */
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** Prefixed-string primary key. */
const id = () => text('id').primaryKey();

/**
 * JSON value objects mirrored from Zod. `phoneNumberValueSchema` and
 * `postalAddressSchema` are not exported as named types from the domain module, so
 * they are restated structurally here rather than re-declared in `src/domain`.
 */
export interface PhoneNumberValue {
  countryCode: string;
  dialCode: string;
  number: string;
  e164?: string;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface VoiceConfigJson {
  providerKey: string;
  voiceId: string;
  speed: number;
  register?: 'formal' | 'informal';
  lexicon: { term: string; pronunciation: string }[];
}

export interface PipelineConfigJson {
  sttProvider: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  endpointingStrategy: string;
  bargeInStrategy: string;
  temperature: number;
  maxTokens: number;
  speculativePrefill: boolean;
  fillerEnabled: boolean;
}

export interface ToolConfigJson {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  parameters: Record<string, unknown>;
}

export interface AgentStatsJson {
  callsToday: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgDurationSec: number;
  costPerCallUsd: number;
}

/** Proof-of-consent blob attached to a call or lead — docs/13 §3. */
export interface ConsentRecord {
  basis: 'express_written' | 'existing_relationship' | 'inbound' | 'legitimate_interest' | 'none';
  capturedAt?: string;
  source?: string;
  evidenceRef?: string;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Users are GLOBAL, not tenant-scoped. One human, one account, many orgs — which is
 * exactly why `users` has no `org_id` and therefore no RLS policy on one. Membership
 * is the tenant-scoped thing, and that is `org_memberships`.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    firstName: text('first_name').notNull(),
    familyName: text('family_name').notNull(),
    jobTitle: text('job_title'),
    phone: jsonb('phone').$type<PhoneNumberValue>(),
    avatarUrl: text('avatar_url'),
    timezone: text('timezone').notNull().default('UTC'),
    locale: text('locale').notNull().default('en-US'),
    createdAt: createdAt(),
    /** Soft-delete marker for GDPR erasure; see README §Right to erasure. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    // Case-insensitive uniqueness without requiring the citext extension.
    emailUq: uniqueIndex('users_email_lower_uq').on(t.email),
  }),
);

/**
 * Organization — the legal entity. `parent_org_id` is the one nullable column that
 * makes the reseller/BPO segment addressable (docs/12 §What I'd fight hardest for).
 * Self-referencing, one level in practice, unconstrained in the schema so an agency
 * of agencies does not require a migration.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    parentOrgId: text('parent_org_id'),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    slug: text('slug').notNull(),
    website: text('website'),
    industry: text('industry'),
    size: text('size'),
    country: char('country', { length: 2 }).notNull(),
    address: jsonb('address').$type<PostalAddress>(),
    phone: jsonb('phone').$type<PhoneNumberValue>(),
    taxId: text('tax_id'),
    billingEmail: text('billing_email'),
    timezone: text('timezone').notNull().default('UTC'),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    logoUrl: text('logo_url'),
    /**
     * Domain-based org discovery (docs/11 §5). A `text[]` rather than a child table:
     * it is a short list, always read whole, and GIN-indexable for the one query that
     * matters — "which org owns this email domain".
     */
    verifiedDomains: text('verified_domains').array().notNull().default([]),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    slugUq: uniqueIndex('organizations_slug_uq').on(t.slug),
    parentIdx: index('organizations_parent_idx').on(t.parentOrgId),
  }),
);

/**
 * Workspace — the business boundary. Region, spend caps, and the compliance profile
 * hang here and nowhere else (docs/12). `region_locked` flips true on the first live
 * call and is never flipped back by the application: moving regions means migrating
 * every call, recording, and trace, which is a support operation.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    region: text('region').$type<Region>().notNull(),
    regionLocked: boolean('region_locked').notNull().default(false),
    compliance: jsonb('compliance').$type<ComplianceProfile>().notNull(),
    spendCaps: jsonb('spend_caps').$type<SpendCaps>().notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    orgSlugUq: uniqueIndex('workspaces_org_slug_uq').on(t.orgId, t.slug),
    orgIdx: index('workspaces_org_idx').on(t.orgId, t.name),
  }),
);

export const orgMemberships = pgTable(
  'org_memberships',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').$type<OrgRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uq: uniqueIndex('org_memberships_org_user_uq').on(t.orgId, t.userId),
    userIdx: index('org_memberships_user_idx').on(t.userId),
  }),
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').$type<WorkspaceRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uq: uniqueIndex('workspace_memberships_ws_user_uq').on(t.workspaceId, t.userId),
    userIdx: index('workspace_memberships_user_idx').on(t.userId),
    orgIdx: index('workspace_memberships_org_idx').on(t.orgId),
  }),
);

/**
 * Invitations carry a HASH of the invite token, never the token. Same reasoning as
 * api_keys: the mail already went out, the database should not be a second copy of
 * the credential.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    /** Null for an org-level invite; set to grant a workspace role at accept time. */
    workspaceId: text('workspace_id'),
    email: text('email').notNull(),
    orgRole: text('org_role').$type<OrgRole>().notNull(),
    workspaceRole: text('workspace_role').$type<WorkspaceRole>(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    status: text('status')
      .$type<'pending' | 'accepted' | 'revoked' | 'expired'>()
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    acceptedByUserId: text('accepted_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenUq: uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    orgEmailIdx: index('invitations_org_email_idx').on(t.orgId, t.email),
  }),
);

/**
 * API keys — workspace-scoped, never org-scoped (docs/10 §Scoping rules, rule 4).
 *
 * We store `key_hash` (SHA-256 of the full secret) and `prefix` (`key_live_ab12cd`).
 * The plaintext is returned exactly once, at creation, and is unrecoverable after.
 * Authentication is: split the presented secret, look up by `prefix` (indexed,
 * unique, cheap), then constant-time compare the hash. That is why `prefix` exists —
 * it turns key auth into a single index probe instead of a table scan of hashes.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    mode: text('mode').$type<Mode>().notNull(),
    /** `key_live_ab12cd` — safe to display, safe to log. */
    prefix: text('prefix').notNull(),
    /** SHA-256 hex of the full secret. NEVER the secret itself. */
    keyHash: text('key_hash').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => ({
    prefixUq: uniqueIndex('api_keys_prefix_uq').on(t.prefix),
    hashUq: uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    wsIdx: index('api_keys_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agents = pgTable(
  'agents',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<'draft' | 'live' | 'paused' | 'archived'>().notNull(),
    /** Monotonic; incremented by publish, mirrors the highest agent_versions row. */
    version: integer('version').notNull().default(1),
    description: text('description').notNull().default(''),
    language: text('language').notNull().default('en-US'),
    prompt: text('prompt').notNull(),
    voice: jsonb('voice').$type<VoiceConfigJson>().notNull(),
    pipeline: jsonb('pipeline').$type<PipelineConfigJson>().notNull(),
    tools: jsonb('tools').$type<ToolConfigJson[]>().notNull().default([]),
    /**
     * Rolled-up counters. Denormalised on purpose: the dashboard reads them on every
     * agent list render and computing them from `calls` per row is an N+1 aggregate.
     * Recomputed by the stats job; never the source of truth.
     */
    stats: jsonb('stats').$type<AgentStatsJson>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    // The list screen: agents in a workspace, most-recently-edited first.
    wsUpdatedIdx: index('agents_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    orgIdx: index('agents_org_idx').on(t.orgId),
  }),
);

/**
 * Immutable published snapshots. A call records which VERSION it ran, so "what
 * exactly was this agent saying on the 3rd of March" is answerable forever, and a
 * prompt edit cannot retroactively rewrite history.
 */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id').notNull(),
    version: integer('version').notNull(),
    prompt: text('prompt').notNull(),
    language: text('language').notNull(),
    voice: jsonb('voice').$type<VoiceConfigJson>().notNull(),
    pipeline: jsonb('pipeline').$type<PipelineConfigJson>().notNull(),
    tools: jsonb('tools').$type<ToolConfigJson[]>().notNull().default([]),
    changeNote: text('change_note'),
    publishedByUserId: text('published_by_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    agentVersionUq: uniqueIndex('agent_versions_agent_version_uq').on(t.agentId, t.version),
    wsIdx: index('agent_versions_ws_idx').on(t.workspaceId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Telephony / campaigns
// ---------------------------------------------------------------------------

export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    e164: text('e164').notNull(),
    country: char('country', { length: 2 }).notNull(),
    provider: text('provider').notNull(),
    /** STIR/SHAKEN attestation level — drives answer rates in the US (docs/13 §2). */
    attestation: text('attestation').$type<'A' | 'B' | 'C' | 'none'>().notNull().default('none'),
    reputationScore: integer('reputation_score'),
    reputationCheckedAt: timestamp('reputation_checked_at', { withTimezone: true, mode: 'date' }),
    /** Cross-workspace references are forbidden — this must live in the same workspace. */
    assignedAgentId: text('assigned_agent_id'),
    status: text('status')
      .$type<'active' | 'pending' | 'released'>()
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (t) => ({
    e164Uq: uniqueIndex('phone_numbers_e164_uq').on(t.e164),
    wsIdx: index('phone_numbers_ws_idx').on(t.workspaceId, t.status),
  }),
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    status: text('status')
      .$type<'draft' | 'running' | 'paused' | 'completed' | 'archived'>()
      .notNull()
      .default('draft'),
    /** Calling windows, pacing, retry policy — read as a unit by the dialer. */
    schedule: jsonb('schedule').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    wsIdx: index('campaigns_ws_updated_idx').on(t.workspaceId, t.updatedAt),
  }),
);

export const leads = pgTable(
  'leads',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    externalRef: text('external_ref'),
    e164: text('e164').notNull(),
    phone: jsonb('phone').$type<PhoneNumberValue>(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Proof of consent. In the US this is the difference between a business and a lawsuit. */
    consent: jsonb('consent').$type<ConsentRecord>(),
    attempts: integer('attempts').notNull().default(0),
    status: text('status')
      .$type<'pending' | 'in_progress' | 'contacted' | 'exhausted' | 'suppressed'>()
      .notNull()
      .default('pending'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => ({
    campaignStatusIdx: index('leads_campaign_status_idx').on(t.campaignId, t.status),
    wsIdx: index('leads_ws_idx').on(t.workspaceId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Calls / turns — the high-volume, retention-governed tables
// ---------------------------------------------------------------------------

/**
 * Calls. This is the table that grows without bound and the table GDPR cares about.
 *
 * `purge_after` is written at insert time as `started_at + workspace.compliance
 * .retentionDays`. Denormalising the deadline onto the row means the retention sweep
 * is one indexed range scan per region and never has to join to `workspaces` or
 * re-read a policy that may have changed since. See README §Retention sweep.
 */
export const calls = pgTable(
  'calls',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id').notNull(),
    agentVersionId: text('agent_version_id'),
    campaignId: text('campaign_id'),
    leadId: text('lead_id'),
    phoneNumberId: text('phone_number_id'),
    direction: text('direction').$type<'inbound' | 'outbound'>().notNull(),
    mode: text('mode').$type<Mode>().notNull().default('test'),
    /** Denormalised from the workspace: residency is a property of the record itself. */
    region: text('region').$type<Region>().notNull(),
    status: text('status')
      .$type<'queued' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'no_answer'>()
      .notNull(),
    disposition: text('disposition'),
    fromE164: text('from_e164'),
    toE164: text('to_e164'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    durationSec: integer('duration_sec'),
    /** numeric(12,6), not float. Money never touches IEEE-754 here. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    recordingUrl: text('recording_url'),
    recordingDeletedAt: timestamp('recording_deleted_at', { withTimezone: true, mode: 'date' }),
    piiRedacted: boolean('pii_redacted').notNull().default(false),
    consent: jsonb('consent').$type<ConsentRecord>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Retention deadline. Indexed; the sweep's only predicate. */
    purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => ({
    // "Recent calls in this workspace" — the default dashboard view.
    wsStartedIdx: index('calls_ws_started_idx').on(t.workspaceId, t.startedAt),
    // "Recent calls for this agent" — the agent detail view.
    wsAgentStartedIdx: index('calls_ws_agent_started_idx').on(
      t.workspaceId,
      t.agentId,
      t.startedAt,
    ),
    // The retention sweep. Partial index (WHERE purge_after IS NOT NULL) in the migration.
    purgeIdx: index('calls_purge_after_idx').on(t.purgeAfter),
    orgIdx: index('calls_org_started_idx').on(t.orgId, t.startedAt),
  }),
);

/**
 * Turns. Two text columns on purpose: `text` is the verbatim transcript and `text_redacted`
 * is the PII-masked rendering. Roles without `call:read_pii` (analyst, viewer — see
 * `domain/tenant.ts`) are served `text_redacted`. Erasure nulls `text` and keeps the
 * redacted form, so aggregate analytics survive a DSAR.
 */
export const turns = pgTable(
  'turns',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    callId: text('call_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').$type<'agent' | 'caller' | 'system' | 'tool'>().notNull(),
    text: text('text'),
    textRedacted: text('text_redacted'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    latencyMs: integer('latency_ms'),
    tokens: integer('tokens'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    callSeqUq: uniqueIndex('turns_call_seq_uq').on(t.callId, t.seq),
    wsIdx: index('turns_ws_started_idx').on(t.workspaceId, t.startedAt),
  }),
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append-only. The application role is granted INSERT and SELECT and nothing else —
 * see `rls.sql` and README §Audit log. A log the app can rewrite is not evidence, and
 * "immutable audit trail" is a literal line item in SOC 2 and in every EU enterprise
 * security questionnaire (docs/13 §2).
 *
 * Sequential bigint id rather than a prefixed string: there is no API surface that
 * addresses an audit row by id, and a gapless sequence makes tampering visible.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    orgId: text('org_id').notNull(),
    workspaceId: text('workspace_id'),
    actorUserId: text('actor_user_id'),
    actorApiKeyId: text('actor_api_key_id'),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    orgAtIdx: index('audit_log_org_at_idx').on(t.orgId, t.at),
    targetIdx: index('audit_log_target_idx').on(t.targetKind, t.targetId),
  }),
);

// ---------------------------------------------------------------------------

/**
 * Every table that carries `org_id` and therefore gets an RLS policy. Kept here so
 * `rls.sql` and this file can be diffed against each other by eye.
 */
export const TENANT_SCOPED_TABLES = [
  'organizations',
  'workspaces',
  'org_memberships',
  'workspace_memberships',
  'invitations',
  'api_keys',
  'agents',
  'agent_versions',
  'phone_numbers',
  'campaigns',
  'leads',
  'calls',
  'turns',
  'audit_log',
] as const;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type CallRow = typeof calls.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
