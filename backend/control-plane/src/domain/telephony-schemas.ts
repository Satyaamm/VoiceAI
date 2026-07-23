/**
 * Telephony domain schemas — phone numbers, campaigns, leads.
 *
 * Kept in a separate file from `schemas.ts` on purpose: the telephony surface is
 * Phase 3 in docs/03 §5 but its *compliance* half is Phase 1 in docs/13 §2, so it
 * moves on a different cadence from the identity/agent core.
 *
 * Everything entering the system from outside is parsed here — nothing downstream
 * accepts `unknown` for a number, campaign, or lead.
 */

import { z } from 'zod';
import { isoCountry } from './schemas.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** E.164: leading '+', country code, subscriber digits. No spaces, no punctuation. */
export const e164Schema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'expected E.164, e.g. +14155550123');

export const numberCapabilitySchema = z.enum(['voice', 'sms', 'mms', 'fax']);

export const numberTypeSchema = z.enum(['local', 'mobile', 'toll_free', 'national', 'shared_cost']);

/**
 * STIR/SHAKEN attestation (docs/03 §I, docs/13 §2).
 *   A — carrier knows the customer AND that they're entitled to the number
 *   B — carrier knows the customer, not the number's provenance
 *   C — gateway attestation only (worst answer rates)
 *   none — outside the SHAKEN framework (most EU traffic today)
 * A-level attestation is the single biggest lever on US answer rate.
 */
export const attestationLevelSchema = z.enum(['A', 'B', 'C', 'none']);

/**
 * Reputation state from the analytics providers that drive "Spam Likely"
 * labelling (docs/03 5.1 / §I). `flagged` numbers must be rotated out of dialing.
 */
export const reputationStatusSchema = z.enum([
  'unknown', // never checked
  'clean',
  'at_risk', // elevated complaint/velocity signal — throttle
  'flagged', // labelled by at least one analytics provider — rotate out
  'blocked', // carrier-level block — unusable
]);

export const reputationSchema = z.object({
  status: reputationStatusSchema.default('unknown'),
  /** 0–100, higher is better. Null until first check. */
  score: z.number().min(0).max(100).nullable().default(null),
  /** Which analytics providers reported a label. */
  sources: z.array(z.string()).default([]),
  lastCheckedAt: z.string().datetime().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Phone number
// ---------------------------------------------------------------------------

export const phoneNumberStatusSchema = z.enum(['active', 'suspended', 'releasing', 'released']);

export const phoneNumberSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  e164: e164Schema,
  country: isoCountry,
  numberType: numberTypeSchema.default('local'),
  capabilities: z.array(numberCapabilitySchema).min(1),
  /** Upstream carrier / number provider key (registry-resolvable). */
  carrier: z.string().min(1),
  /** Trunk this number dials out on — the token-bucket key in the dialer. */
  trunkId: z.string().min(1).default('default'),
  attestation: attestationLevelSchema.default('none'),
  /** Branded caller ID (CNAM). US-only in practice. */
  cnamLabel: z.string().max(15).optional(),
  reputation: reputationSchema,
  /** Rental cost, excluding per-minute usage. */
  monthlyCostUsd: z.number().min(0),
  /** Agent that answers inbound on this number / dials outbound from it. */
  assignedAgentId: z.string().nullable().default(null),
  status: phoneNumberStatusSchema.default('active'),
  purchasedAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable().default(null),
});

/** A number offered by the upstream provider but not yet owned. */
export const availableNumberSchema = z.object({
  e164: e164Schema,
  country: isoCountry,
  numberType: numberTypeSchema,
  capabilities: z.array(numberCapabilitySchema).min(1),
  carrier: z.string().min(1),
  monthlyCostUsd: z.number().min(0),
  setupCostUsd: z.number().min(0).default(0),
  region: z.string().optional(),
  locality: z.string().optional(),
  /**
   * True when the destination regulator requires a local address or legal entity
   * before the number can be held (docs/13 §5 — DE, IT, ES among others).
   */
  requiresLocalAddress: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export const campaignStatusSchema = z.enum([
  'draft',
  'running',
  'paused',
  'stopped',
  'completed',
]);

/**
 * Pacing. `callsPerSecond` is the carrier-facing constraint — carriers block a
 * trunk on a CPS spike long before capacity is reached (docs/03 5.2), so this is
 * enforced with a token bucket, not a best-effort sleep.
 */
export const pacingSchema = z.object({
  callsPerSecond: z.number().min(0.05).max(50).default(1),
  /** Burst allowance for the token bucket. */
  burst: z.number().int().min(1).max(200).default(3),
  maxConcurrentCalls: z.number().int().min(1).max(10_000).default(10),
  /**
   * Per-number hourly cap. A number doing 500 calls/hour gets flagged;
   * 50/hour doesn't (docs/03 §I).
   */
  maxCallsPerNumberPerHour: z.number().int().min(1).max(1_000).default(50),
});

export const campaignScheduleSchema = z.object({
  /**
   * Windows are evaluated in the CALLEE's local time, never the campaign owner's.
   * When empty, the workspace compliance profile's windows apply — which is the
   * safe default, since those are the legally binding ones.
   */
  windows: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
      }),
    )
    .default([]),
  startAt: z.string().datetime().nullable().default(null),
  endAt: z.string().datetime().nullable().default(null),
});

export const retryPolicySchema = z.object({
  /**
   * Capped again at dispatch by `ComplianceProfile.maxAttemptsPerLead` — whichever
   * is LOWER wins. A campaign cannot buy its way past the compliance cap.
   */
  maxAttempts: z.number().int().min(1).max(20).default(3),
  /** Exponential backoff: base * factor^(attempt-1), clamped to maxBackoffSeconds. */
  backoffBaseSeconds: z.number().int().min(30).max(86_400).default(900),
  backoffFactor: z.number().min(1).max(10).default(2),
  maxBackoffSeconds: z.number().int().min(60).max(2_592_000).default(86_400),
  /** Outcomes that are worth another attempt. */
  retryOn: z
    .array(z.enum(['no_answer', 'busy', 'voicemail', 'failed']))
    .default(['no_answer', 'busy', 'failed']),
});

export const campaignStatsSchema = z.object({
  totalLeads: z.number().int().min(0).default(0),
  pending: z.number().int().min(0).default(0),
  inFlight: z.number().int().min(0).default(0),
  completed: z.number().int().min(0).default(0),
  blocked: z.number().int().min(0).default(0),
  exhausted: z.number().int().min(0).default(0),
  dialsPlaced: z.number().int().min(0).default(0),
});

export const campaignSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  status: campaignStatusSchema.default('draft'),
  /** Numbers this campaign dials FROM. Rotated on reputation flags. */
  callerNumberIds: z.array(z.string()).default([]),
  pacing: pacingSchema,
  schedule: campaignScheduleSchema,
  retryPolicy: retryPolicySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  stoppedAt: z.string().datetime().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

export const leadOutcomeSchema = z.enum([
  'none',
  'answered',
  'no_answer',
  'busy',
  'voicemail',
  'failed',
  'blocked_compliance',
  'do_not_call',
]);

export const leadStateSchema = z.enum([
  'pending',
  'in_flight',
  'retry_scheduled',
  'completed',
  'exhausted',
  'suppressed', // DNC or compliance block — never dial again without review
]);

/**
 * Proof of prior express written consent. We store a REFERENCE, not the artifact:
 * the artifact (signed form, recorded opt-in, web form capture) lives in the
 * evidence store with its own retention clock. docs/13 §3.
 */
export const consentProofSchema = z.object({
  /** Opaque id in the evidence store. */
  ref: z.string().min(1),
  channel: z.enum(['web_form', 'signed_document', 'recorded_oral', 'sms_reply', 'imported']),
  capturedAt: z.string().datetime(),
  /** Text the consumer actually agreed to — the thing a court asks for. */
  disclosureVersion: z.string().min(1),
  /** Present for web captures; strong evidence in a TCPA dispute. */
  sourceIp: z.string().optional(),
  expiresAt: z.string().datetime().nullable().default(null),
});

export const leadSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  campaignId: z.string(),
  e164: e164Schema,
  /** ISO country of the CALLEE's number — drives jurisdiction and local time. */
  country: isoCountry,
  /** US state when known — drives two-party recording consent (docs/13 §2). */
  state: z.string().max(2).optional(),
  /** IANA zone when the customer supplied one; otherwise inferred from country. */
  timezone: z.string().nullable().default(null),
  /** True when the line is known to be mobile — the TCPA trigger in the US. */
  isMobile: z.boolean().default(false),
  displayName: z.string().max(200).optional(),
  attemptCount: z.number().int().min(0).default(0),
  lastOutcome: leadOutcomeSchema.default('none'),
  lastAttemptAt: z.string().datetime().nullable().default(null),
  nextAttemptAt: z.string().datetime().nullable().default(null),
  /** Dialing lifecycle. Named `lifecycle` because `state` is the US state field. */
  lifecycle: leadStateSchema.default('pending'),
  consentProof: consentProofSchema.nullable().default(null),
  onDncList: z.boolean().default(false),
  metadata: z.record(z.string()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Write DTOs — narrower than the read models. Ids, tenancy, stats, reputation
// and attestation are all server- or carrier-assigned, never client-supplied.
// ---------------------------------------------------------------------------

export const searchNumbersQuery = z.object({
  country: isoCountry,
  numberType: numberTypeSchema.optional(),
  /** Area code / city prefix, digits only. */
  areaCode: z.string().regex(/^\d{1,5}$/).optional(),
  contains: z.string().regex(/^\d{1,10}$/).optional(),
  capabilities: z.array(numberCapabilitySchema).default(['voice']),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const purchaseNumberInput = z.object({
  e164: e164Schema,
  country: isoCountry,
  /** Optional immediate assignment. */
  agentId: z.string().optional(),
  cnamLabel: z.string().max(15).optional(),
  trunkId: z.string().min(1).optional(),
});

export const assignNumberInput = z.object({
  agentId: z.string().nullable(),
});

export const createCampaignInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  agentId: z.string().min(1),
  callerNumberIds: z.array(z.string()).default([]),
  pacing: pacingSchema.partial().optional(),
  schedule: campaignScheduleSchema.partial().optional(),
  retryPolicy: retryPolicySchema.partial().optional(),
});

export const updateCampaignInput = createCampaignInput.partial();

export const createLeadInput = z.object({
  e164: e164Schema,
  country: isoCountry,
  state: z.string().max(2).optional(),
  timezone: z.string().optional(),
  isMobile: z.boolean().optional(),
  displayName: z.string().max(200).optional(),
  consentProof: consentProofSchema.optional(),
  metadata: z.record(z.string()).optional(),
});

// ---------------------------------------------------------------------------

export type PhoneNumber = z.infer<typeof phoneNumberSchema>;
export type AvailableNumber = z.infer<typeof availableNumberSchema>;
export type NumberCapability = z.infer<typeof numberCapabilitySchema>;
export type NumberType = z.infer<typeof numberTypeSchema>;
export type AttestationLevel = z.infer<typeof attestationLevelSchema>;
export type ReputationStatus = z.infer<typeof reputationStatusSchema>;
export type NumberReputation = z.infer<typeof reputationSchema>;
export type PhoneNumberStatus = z.infer<typeof phoneNumberStatusSchema>;

export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;
export type Pacing = z.infer<typeof pacingSchema>;
export type CampaignSchedule = z.infer<typeof campaignScheduleSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type CampaignStats = z.infer<typeof campaignStatsSchema>;

export type Lead = z.infer<typeof leadSchema>;
export type LeadOutcome = z.infer<typeof leadOutcomeSchema>;
export type LeadState = z.infer<typeof leadStateSchema>;
export type ConsentProof = z.infer<typeof consentProofSchema>;

export type SearchNumbersQuery = z.infer<typeof searchNumbersQuery>;
export type PurchaseNumberInput = z.infer<typeof purchaseNumberInput>;
export type CreateCampaignInput = z.infer<typeof createCampaignInput>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignInput>;
export type CreateLeadInput = z.infer<typeof createLeadInput>;
