/**
 * Zod schemas — the runtime mirror of `frontend/src/lib/contract.ts`.
 *
 * Everything entering the system from outside is parsed here. Nothing downstream
 * accepts `unknown` or `any` for a domain object.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const isoCountry = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'expected ISO 3166-1 alpha-2, uppercase');

export const phoneNumberValueSchema = z.object({
  countryCode: isoCountry,
  dialCode: z.string().regex(/^\+\d{1,4}$/),
  number: z.string().regex(/^\d{4,15}$/, 'digits only, no spaces or punctuation'),
  e164: z.string().regex(/^\+\d{6,15}$/).optional(),
});

export const postalAddressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(120),
  state: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  country: isoCountry,
});

export const regionSchema = z.enum(['us-east', 'us-west', 'eu-west', 'eu-central']);
export const modeSchema = z.enum(['test', 'live']);

/** Region -> the jurisdiction its data physically sits in. Drives residency checks. */
export const REGION_META: Record<
  z.infer<typeof regionSchema>,
  { label: string; country: string; dataBloc: 'US' | 'EU' }
> = {
  'us-east': { label: 'US East (Virginia)', country: 'US', dataBloc: 'US' },
  'us-west': { label: 'US West (Oregon)', country: 'US', dataBloc: 'US' },
  'eu-west': { label: 'EU West (Ireland)', country: 'IE', dataBloc: 'EU' },
  'eu-central': { label: 'EU Central (Frankfurt)', country: 'DE', dataBloc: 'EU' },
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const orgRoleSchema = z.enum(['owner', 'admin', 'billing_admin', 'member']);
export const workspaceRoleSchema = z.enum([
  'workspace_admin',
  'developer',
  'analyst',
  'viewer',
]);
export const orgSizeSchema = z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']);

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  firstName: z.string().min(1).max(80),
  familyName: z.string().min(1).max(80),
  jobTitle: z.string().max(120).optional(),
  phone: phoneNumberValueSchema.optional(),
  avatarUrl: z.string().url().optional(),
  timezone: z.string().min(1),
  locale: z.string().min(2),
  createdAt: z.string().datetime(),
});

export const organizationSchema = z.object({
  id: z.string(),
  parentOrgId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
  legalName: z.string().max(200).optional(),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase alphanumerics and hyphens'),
  website: z.string().url().optional(),
  industry: z.string().max(80).optional(),
  size: orgSizeSchema.optional(),
  country: isoCountry,
  address: postalAddressSchema.optional(),
  phone: phoneNumberValueSchema.optional(),
  taxId: z.string().max(40).optional(),
  billingEmail: z.string().email().optional(),
  timezone: z.string(),
  currency: z.string().length(3),
  logoUrl: z.string().url().optional(),
  verifiedDomains: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const complianceProfileSchema = z.object({
  jurisdictions: z.array(isoCountry).default([]),
  consentModel: z.enum(['one_party', 'two_party', 'none']).default('one_party'),
  aiDisclosureRequired: z.boolean().default(true),
  aiDisclosureText: z.record(z.string()).default({}),
  callingWindows: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
      }),
    )
    .default([]),
  dncRegistries: z.array(z.string()).default([]),
  maxAttemptsPerLead: z.number().int().min(1).max(20).default(3),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  piiRedaction: z.boolean().default(true),
  requireConsentProof: z.boolean().default(false),
  /**
   * HIPAA-eligible workspace. docs/14 §1 — this is a HARD constraint, not a label:
   * it restricts the provider list to BAA-covered, zero-retention processors
   * (compliance/provider-eligibility.ts) and forces PII redaction on.
   * Off by default; must never be enabled without a signed BAA on every link.
   */
  hipaaMode: z.boolean().default(false),
  /**
   * The customer's declared lawful basis for processing (GDPR Art. 6). We are the
   * processor; they are the controller. Recorded for the Art. 30 register.
   */
  lawfulBasis: z
    .enum(['consent', 'contract', 'legal_obligation', 'legitimate_interests', 'vital_interests', 'public_task'])
    .default('legitimate_interests'),
});

export const spendCapsSchema = z.object({
  monthlyUsd: z.number().positive().nullable().default(null),
  dailyUsd: z.number().positive().nullable().default(null),
  perCallUsd: z.number().positive().nullable().default(null),
  breachAction: z.enum(['degrade', 'wrap_up', 'hard_stop']).default('wrap_up'),
});

export const workspaceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  description: z.string().max(500).optional(),
  region: regionSchema,
  regionLocked: z.boolean().default(false),
  compliance: complianceProfileSchema,
  spendCaps: spendCapsSchema,
  spend: z.object({ todayUsd: z.number(), monthUsd: z.number() }).optional(),
  createdAt: z.string().datetime(),
  stats: z
    .object({
      agentCount: z.number().int(),
      numberCount: z.number().int(),
      callsToday: z.number().int(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const voiceConfigSchema = z.object({
  providerKey: z.string(),
  voiceId: z.string(),
  speed: z.number().min(0.5).max(2).default(1),
  register: z.enum(['formal', 'informal']).optional(),
  lexicon: z
    .array(z.object({ term: z.string().min(1), pronunciation: z.string().min(1) }))
    .default([]),
});

export const pipelineConfigSchema = z.object({
  sttProvider: z.string(),
  llmProvider: z.string(),
  llmModel: z.string(),
  ttsProvider: z.string(),
  endpointingStrategy: z.string().default('semantic'),
  bargeInStrategy: z.string().default('target-speaker'),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(16).max(4096).default(300),
  speculativePrefill: z.boolean().default(true),
  fillerEnabled: z.boolean().default(true),
});

export const toolConfigSchema = z.object({
  id: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case identifier'),
  description: z.string().min(1).max(500),
  endpoint: z.string().url(),
  method: z.enum(['GET', 'POST']).default('POST'),
  timeoutMs: z.number().int().min(100).max(30_000).default(3_000),
  parameters: z.record(z.unknown()).default({}),
});

export const agentStatusSchema = z.enum(['draft', 'live', 'paused', 'archived']);

export const agentSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(120),
  status: agentStatusSchema,
  version: z.number().int().min(1),
  description: z.string().max(500).default(''),
  language: z.string().min(2).default('en-US'),
  prompt: z.string().min(1).max(100_000),
  voice: voiceConfigSchema,
  pipeline: pipelineConfigSchema,
  tools: z.array(toolConfigSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stats: z.object({
    callsToday: z.number().int(),
    successRate: z.number(),
    avgLatencyMs: z.number(),
    p95LatencyMs: z.number(),
    avgDurationSec: z.number(),
    costPerCallUsd: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Write DTOs — what the API accepts. Deliberately narrower than the read models:
// ids, versions, stats, and tenancy are server-assigned, never client-supplied.
// ---------------------------------------------------------------------------

export const createWorkspaceInput = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/).optional(),
  description: z.string().max(500).optional(),
  region: regionSchema,
  compliance: complianceProfileSchema.partial().optional(),
  spendCaps: spendCapsSchema.partial().optional(),
});

/**
 * Region stays editable here on purpose — it's changeable until the workspace holds
 * real call data (docs/11 §B). The lock is a lifecycle rule enforced in
 * WorkspaceService, not a schema constraint.
 */
export const updateWorkspaceInput = createWorkspaceInput.partial();

export const createAgentInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  language: z.string().min(2).default('en-US'),
  prompt: z.string().min(1).max(100_000),
  voice: voiceConfigSchema.partial().optional(),
  pipeline: pipelineConfigSchema.partial().optional(),
});

export const updateAgentInput = createAgentInput.partial();

export const publishAgentInput = z.object({
  changeNote: z.string().max(500).optional(),
});

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------

export type User = z.infer<typeof userSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type ComplianceProfile = z.infer<typeof complianceProfileSchema>;
export type SpendCaps = z.infer<typeof spendCapsSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type OrgRole = z.infer<typeof orgRoleSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type Region = z.infer<typeof regionSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInput>;
export type CreateAgentInput = z.infer<typeof createAgentInput>;
