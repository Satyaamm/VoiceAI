/**
 * Shared API contract — single source of truth for everything crossing the wire
 * between `backend/control-plane` and this dashboard.
 *
 * The backend mirrors these as Zod schemas in `src/domain/` and validates at the
 * boundary. Changing a type here means changing the Zod schema too.
 *
 * Hierarchy (docs/10, docs/12):
 *   User --membership--> Organization --> Workspace --> Agent / Number / Campaign / Call
 *
 * A Workspace is a BUSINESS boundary (brand, business unit, end-client) — not an
 * environment. Environments are handled by `mode: test | live`.
 */

// ===========================================================================
// Primitives
// ===========================================================================

/** Country-code-aware phone number. Stored normalised as E.164. */
export interface PhoneNumberValue {
  /** ISO 3166-1 alpha-2, e.g. 'DE'. Drives flag + dial code in the UI. */
  countryCode: string;
  /** e.g. '+49'. */
  dialCode: string;
  /** National significant number, digits only. */
  number: string;
  /** Server-normalised, e.g. '+4915112345678'. Read-only from the client. */
  e164?: string;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** Data residency. See docs/13 §5 — eu-central is Frankfurt, required by many DE customers. */
export type Region = 'us-east' | 'us-west' | 'eu-west' | 'eu-central';

/** Stripe-style mode. Test = browser/test numbers only, no PSTN spend. */
export type Mode = 'test' | 'live';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ===========================================================================
// Identity
// ===========================================================================

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  /** Separate fields — never a single "full name". */
  firstName: string;
  familyName: string;
  jobTitle?: string;
  phone?: PhoneNumberValue;
  avatarUrl?: string;
  /** IANA timezone, e.g. 'Europe/Berlin'. */
  timezone: string;
  /** BCP-47, e.g. 'de-DE'. */
  locale: string;
  createdAt: string;
}

export type OrgRole = 'owner' | 'admin' | 'billing_admin' | 'member';
export type WorkspaceRole = 'workspace_admin' | 'developer' | 'analyst' | 'viewer';
export type OrgSize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+';

export interface Organization {
  id: string;
  /**
   * Non-null for reseller / BPO child accounts. docs/12 §5 — one nullable column
   * that keeps the agency segment reachable without a later migration.
   */
  parentOrgId?: string | null;
  /** Display name, e.g. 'Acme'. */
  name: string;
  /** For invoices and contracts, e.g. 'Acme Technologies GmbH'. */
  legalName?: string;
  /** Globally unique URL segment. */
  slug: string;
  website?: string;
  industry?: string;
  size?: OrgSize;
  /** ISO 3166-1 alpha-2 — drives tax label, compliance defaults, dial code. */
  country: string;
  address?: PostalAddress;
  phone?: PhoneNumberValue;
  /** VAT in the EU, EIN in the US. Label follows country. */
  taxId?: string;
  billingEmail?: string;
  timezone: string;
  /** ISO 4217, e.g. 'EUR'. */
  currency: string;
  logoUrl?: string;
  /** Verified email domains — enables org auto-discovery (docs/11 §5). */
  verifiedDomains: string[];
  createdAt: string;
}

// ===========================================================================
// Workspace — the business boundary
// ===========================================================================

/**
 * Per-workspace compliance posture. docs/13 §2.
 *
 * This is workspace-scoped, not org-scoped, because a BPO calling for a bank and
 * for a retailer has two different postures. No competitor models this.
 */
export interface ComplianceProfile {
  /** ISO country codes this workspace is permitted to call. */
  jurisdictions: string[];
  /** Recording consent model. 'two_party' required in DE, FR, and several US states. */
  consentModel: 'one_party' | 'two_party' | 'none';
  /** EU AI Act transparency obligation — the caller must be told it's an AI. */
  aiDisclosureRequired: boolean;
  /** Spoken at call start when disclosure is required. Per-locale. */
  aiDisclosureText: Record<string, string>;
  /** Calling windows in the CALLEE's local time, 24h clock. */
  callingWindows: Array<{ dayOfWeek: number; startHour: number; endHour: number }>;
  /** DNC registries to check before dispatch. */
  dncRegistries: string[];
  /** Max dial attempts per lead. */
  maxAttemptsPerLead: number;
  /** Recording/transcript retention. Bounded by the org's contract tier. */
  retentionDays: number;
  /** Streaming PII redaction before LLM context and before storage. */
  piiRedaction: boolean;
  /** Require proof of prior express written consent before outbound (US TCPA). */
  requireConsentProof: boolean;
  /**
   * HIPAA-eligible workspace. docs/14 §1 — a HARD constraint, not a label: it
   * restricts selectable providers to BAA-covered, zero-retention processors and
   * forces PII redaction on. The UI must show WHY a provider is unavailable.
   */
  hipaaMode: boolean;
  /** Customer's declared lawful basis (GDPR Art. 6). They are the controller. */
  lawfulBasis:
    | 'consent' | 'contract' | 'legal_obligation'
    | 'legitimate_interests' | 'vital_interests' | 'public_task';
}

/**
 * Why a provider cannot be selected for this workspace. Returned by
 * GET /v1/capabilities so the UI can disable an option WITH a reason rather than
 * silently hiding it — "why can't I pick Deepgram?" must be answerable in the UI.
 */
export interface ProviderEligibility {
  providerKey: string;
  eligible: boolean;
  reasons: Array<{
    code:
      | 'residency_mismatch' | 'no_baa' | 'no_dpa'
      | 'retains_data' | 'trains_on_data' | 'undeclared_posture';
    message: string;
  }>;
}

/** The sub-processor register customers request during procurement. */
export interface SubprocessorEntry {
  provider: string;
  purpose: string;
  location: string;
  dpa: string;
  baa: string;
  retention: string;
  notes: string;
}

/** Append-only audit trail. SOC 2 CC7.2, HIPAA §164.312(b). */
export interface AuditEntry {
  id: string;
  sequence: number;
  timestamp: string;
  orgId: string;
  workspaceId: string | null;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  outcome: 'success' | 'failure';
}

/** docs/12 §3 — a hard resource limit, not a billing preference. */
export interface SpendCaps {
  monthlyUsd: number | null;
  dailyUsd: number | null;
  perCallUsd: number | null;
  /** What happens on breach. */
  breachAction: 'degrade' | 'wrap_up' | 'hard_stop';
}

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  /** Unique within the org. */
  slug: string;
  description?: string;
  /** Inferred at creation; locked once real call data exists (docs/11 §B). */
  region: Region;
  regionLocked: boolean;
  compliance: ComplianceProfile;
  spendCaps: SpendCaps;
  /** Live spend against the caps, for the header burn-rate indicator. */
  spend?: { todayUsd: number; monthUsd: number };
  createdAt: string;
  stats?: {
    agentCount: number;
    numberCount: number;
    callsToday: number;
  };
}

export interface OrgMembership {
  id: string;
  orgId: string;
  user: Pick<User, 'id' | 'email' | 'firstName' | 'familyName' | 'avatarUrl'>;
  role: OrgRole;
  /** Explicit grants. Org owners/admins have implicit access to all workspaces. */
  workspaceRoles: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole }>;
  joinedAt: string;
  lastActiveAt?: string;
}

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  workspaceGrants: Array<{ workspaceId: string; role: WorkspaceRole }>;
  invitedBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  /** Only the prefix is returned after creation, e.g. 'key_live_a1b2…'. */
  prefix: string;
  /** Full secret — returned exactly once, at creation. */
  secret?: string;
  mode: Mode;
  lastUsedAt?: string;
  createdBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  createdAt: string;
  revokedAt?: string;
}

// ===========================================================================
// Session — everything the shell needs on load
// ===========================================================================

export interface Session {
  user: User;
  organizations: Array<
    Pick<Organization, 'id' | 'name' | 'slug' | 'logoUrl'> & { role: OrgRole }
  >;
  workspaces: Array<
    Pick<Workspace, 'id' | 'orgId' | 'name' | 'slug' | 'region'> & { role: WorkspaceRole }
  >;
  currentOrgId: string | null;
  currentWorkspaceId: string | null;
  mode: Mode;
  /** Effective permission strings in the current scope — drives UI gating. */
  permissions: Permission[];
  onboarding: OnboardingState;
}

/** Checked as `(user, org, workspace, action)` by a single authorization service. */
export type Permission =
  | 'org:read' | 'org:write' | 'org:billing' | 'org:members'
  | 'workspace:read' | 'workspace:write' | 'workspace:create'
  | 'agent:read' | 'agent:write' | 'agent:publish'
  | 'call:read' | 'call:read_pii' | 'call:place_test'
  | 'number:manage' | 'campaign:manage' | 'apikey:manage';

/**
 * Just-in-time onboarding (docs/11 §Revised). NOT a blocking wizard — these flags
 * drive contextual prompts at the moment each field is actually needed.
 */
export interface OnboardingState {
  emailVerified: boolean;
  /** The one true activation metric. Target: under 60s from signup. */
  hasTalkedToAgent: boolean;
  /** Ask before first invite or first live call. */
  needsUserDetails: boolean;
  /** Ask when adding a payment method. */
  needsOrgBillingDetails: boolean;
  /** Ask before the first live call; locked afterwards. */
  needsRegionConfirmation: boolean;
  /** Dismissible profile card, never a blocker. */
  showProfileCard: boolean;
}

// ===========================================================================
// Agent
// ===========================================================================

export type AgentStatus = 'draft' | 'live' | 'paused' | 'archived';

export interface Agent {
  id: string;
  orgId: string;
  workspaceId: string;
  name: string;
  status: AgentStatus;
  /** Immutable version counter — every publish increments (problem 6.7). */
  version: number;
  description: string;
  /** BCP-47 primary language. docs/13 §4 — non-English quality is the wedge. */
  language: string;
  prompt: string;
  voice: VoiceConfig;
  pipeline: PipelineConfig;
  tools: ToolConfig[];
  createdAt: string;
  updatedAt: string;
  stats: AgentStats;
}

export interface AgentStats {
  callsToday: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgDurationSec: number;
  costPerCallUsd: number;
}

export interface VoiceConfig {
  providerKey: string;
  voiceId: string;
  speed: number;
  /**
   * Formal/informal register. Getting du/Sie or tu/vous wrong is a real error in
   * DE/FR in a way English has no equivalent for. docs/13 §4.
   */
  register?: 'formal' | 'informal';
  /** Per-tenant pronunciation overrides — docs/03 §D. */
  lexicon: Array<{ term: string; pronunciation: string }>;
}

export interface PipelineConfig {
  sttProvider: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  /** Registry key: 'semantic' | 'fixed-silence'. */
  endpointingStrategy: string;
  /** Registry key: 'target-speaker' | 'any-speech'. */
  bargeInStrategy: string;
  temperature: number;
  maxTokens: number;
  /** docs/02 — start LLM prefill before the caller finishes. */
  speculativePrefill: boolean;
  fillerEnabled: boolean;
}

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  parameters: Record<string, unknown>;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  publishedBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  publishedAt: string;
  changeNote?: string;
  snapshot: Pick<Agent, 'prompt' | 'voice' | 'pipeline' | 'tools' | 'language'>;
}

// ===========================================================================
// Call
// ===========================================================================

export type CallStatus = 'ringing' | 'active' | 'completed' | 'failed' | 'no_answer';
export type CallDirection = 'inbound' | 'outbound';
export type CallOutcome = 'resolved' | 'escalated' | 'abandoned' | 'voicemail' | 'unknown';

export interface Call {
  id: string;
  orgId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  mode: Mode;
  direction: CallDirection;
  status: CallStatus;
  outcome: CallOutcome;
  fromNumber: string;
  toNumber: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  turnCount: number;
  /** Median end-of-speech to first-audio across this call's turns. */
  medianLatencyMs: number;
  p95LatencyMs: number;
  costUsd: number;
  bargeInCount: number;
  agentVersion: number;
  /** Set when compliance blocked or flagged the call. */
  complianceFlags?: string[];
}

// ===========================================================================
// Trace — what the call trace viewer renders
// ===========================================================================

export type TurnRole = 'caller' | 'agent';

export interface Turn {
  index: number;
  role: TurnRole;
  transcript: string;
  startMs: number;
  endMs: number;
  /** Agent turns only. */
  latency?: LatencyBreakdown;
  /** Whether this agent turn was cut short by the caller. */
  interrupted?: boolean;
  /** Of the generated text, how much was actually played out before barge-in. */
  playedOutChars?: number;
  toolCalls?: TraceToolCall[];
  guardrails?: Array<{ key: string; action: string; reason: string }>;
}

export interface LatencyBreakdown {
  /** end-of-speech -> first audio out. The number that matters. */
  totalMs: number;
  endpointingMs: number;
  sttFinalizeMs: number;
  llmTtftMs: number;
  ttsTtfbMs: number;
  networkMs: number;
  prefixCacheHit: boolean;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export interface TraceToolCall {
  name: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'timeout' | 'error';
  request: unknown;
  response: unknown;
}

export interface TraceEvent {
  tMs: number;
  lane: 'vad' | 'endpoint' | 'stt' | 'llm' | 'tts' | 'tool' | 'guardrail' | 'bargein';
  type: string;
  value?: number;
  text?: string;
}

export interface CallTrace {
  call: Call;
  turns: Turn[];
  events: TraceEvent[];
  /** Downsampled envelopes, one value per `binMs`, 0..1. */
  waveform: { caller: number[]; agent: number[]; binMs: number };
}

// ===========================================================================
// Platform metadata (registry-driven dropdowns)
// ===========================================================================

export interface ProviderOption {
  value: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface PlatformCapabilities {
  stt: ProviderOption[];
  llm: ProviderOption[];
  tts: ProviderOption[];
  endpointing: ProviderOption[];
  bargeIn: ProviderOption[];
  regions: Array<{ value: Region; label: string; country: string }>;
  languages: Array<{ value: string; label: string; ttsQuality: 'native' | 'good' | 'beta' }>;
}

export interface ProviderHealth {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  state: 'closed' | 'open' | 'half-open';
}

// ===========================================================================
// Overview
// ===========================================================================

export interface OverviewMetrics {
  activeCalls: number;
  callsToday: number;
  concurrentPeak: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  costTodayUsd: number;
  latencySeries: Array<{ t: string; p50: number; p95: number }>;
  callVolumeSeries: Array<{ t: string; inbound: number; outbound: number }>;
}
