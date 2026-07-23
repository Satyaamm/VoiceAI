/**
 * Dialer — pacing + the pre-dispatch compliance gate.
 *
 * This is the most legally load-bearing file in the control plane. Under the FCC's
 * treatment of AI voices as "artificial" for TCPA purposes (docs/13 §3), a US
 * outbound dial to a mobile without documented prior express written consent is a
 * per-call, plaintiff-friendly liability. So the gate here **fails closed**: if we
 * cannot prove a dial is permitted, we do not place it.
 *
 * Design constraints, in priority order:
 *
 * 1. **Every lead runs through `buildComplianceChain()` before dispatch.** There is
 *    no code path that places a call without a `DispatchDecision`.
 * 2. **Every decision is audited immutably**, allowed or blocked (docs/03 7.5).
 * 3. **Carrier-safe pacing.** Token bucket per (trunk, destination country).
 *    Carriers block a trunk on a CPS spike long before capacity (docs/03 5.2).
 *    Backpressure is *returned* (`retryAfterMs`), never absorbed by sleeping — a
 *    dialer that sleeps cannot be driven by a workflow engine.
 * 4. **Temporal-ready** (docs/05 layer 3). All decision logic is pure functions over
 *    plain data; every side effect (clock, DNC lookup, call origination, audit
 *    write) is behind `DialerEffects`. When Temporal lands, the pure functions
 *    become deterministic workflow code and `DialerEffects` becomes the activity
 *    interface — with no change to this file's logic. No Temporal dependency here.
 */

import type { ComplianceProfile } from '../domain/schemas.js';
import type { WorkspaceScope } from '../domain/tenant.js';
import type {
  Campaign,
  ConsentProof,
  Lead,
  LeadOutcome,
  PhoneNumber,
  RetryPolicy,
} from '../domain/telephony-schemas.js';
import type {
  DispatchAuditEntry,
  LeadRepository,
} from '../repositories/telephony-repository.js';
import type { HandlerChain } from '../core/patterns/chain.js';
import type { DispatchContext, DispatchDecision } from './compliance.js';

// ===========================================================================
// 1. Callee local time
// ===========================================================================

/**
 * SIMPLIFICATION — read this before trusting the calling-window rule.
 *
 * The legally correct input is the callee's local wall-clock time. We get it two
 * ways, in order of preference:
 *
 *   (a) `lead.timezone` — an IANA zone supplied with the lead. Resolved with
 *       `Intl.DateTimeFormat`, which is DST-correct. This is the right answer and
 *       is what a production import should always populate.
 *
 *   (b) A fixed country -> UTC-offset table (below). This is a DELIBERATE
 *       SIMPLIFICATION with two known errors:
 *         - It ignores DST, so it can be an hour off for ~7 months of the year.
 *         - It uses one offset per country, which is wrong for the US, Canada,
 *           Russia, Brazil, Australia and others spanning multiple zones. For the
 *           US we use US-Eastern.
 *
 * Both errors can push a dial outside the permitted window. The offsets below are
 * therefore chosen to be CONSERVATIVE where a choice exists (US-Eastern rather
 * than US-Pacific means a 9pm Eastern cut-off applies to a 6pm Pacific callee —
 * we under-dial rather than over-dial).
 *
 * ⚖️ The real fix is per-lead timezone resolution from the NPA-NXX / number range,
 * which is Phase 3 work in docs/03 §I. Until then, importing leads without a
 * timezone in a multi-zone country is a known compliance gap — flagged for counsel.
 */
export const COUNTRY_UTC_OFFSET_MINUTES: Record<string, number> = {
  US: -300, // US-Eastern (standard). Conservative for the western zones.
  CA: -300,
  MX: -360,
  BR: -180,
  GB: 0,
  IE: 0,
  PT: 0,
  FR: 60,
  DE: 60,
  ES: 60,
  IT: 60,
  NL: 60,
  BE: 60,
  AT: 60,
  CH: 60,
  PL: 60,
  SE: 60,
  DK: 60,
  NO: 60,
  CZ: 60,
  HU: 60,
  FI: 120,
  GR: 120,
  RO: 120,
  BG: 120,
  AE: 240,
  IN: 330,
  SG: 480,
  AU: 600,
  NZ: 720,
};

export type LocalTimeSource = 'iana' | 'country_offset' | 'utc_fallback';

export interface CalleeLocalTime {
  /** 0 = Sunday, matching `ComplianceProfile.callingWindows`. */
  dayOfWeek: number;
  /** 0–23, local wall clock. */
  hour: number;
  source: LocalTimeSource;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** PURE. Callee wall-clock time for the calling-window rule. */
export function calleeLocalTime(
  at: Date,
  country: string,
  timezone?: string | null,
): CalleeLocalTime {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(at);

      const weekday = parts.find((p) => p.type === 'weekday')?.value;
      const hourRaw = parts.find((p) => p.type === 'hour')?.value;
      const dayOfWeek = weekday ? WEEKDAY_INDEX[weekday] : undefined;
      const hour = hourRaw === undefined ? undefined : Number(hourRaw) % 24;

      if (dayOfWeek !== undefined && hour !== undefined && Number.isFinite(hour)) {
        return { dayOfWeek, hour, source: 'iana' };
      }
    } catch {
      // Unknown zone string — fall through to the offset table rather than throw.
      // A bad timezone must not become a reason to dial without a window check.
    }
  }

  const offset = COUNTRY_UTC_OFFSET_MINUTES[country.toUpperCase()];
  const shifted = new Date(at.getTime() + (offset ?? 0) * 60_000);
  return {
    dayOfWeek: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    source: offset === undefined ? 'utc_fallback' : 'country_offset',
  };
}

// ===========================================================================
// 2. Token bucket (pacing)
// ===========================================================================

export type BucketOutcome =
  | { readonly granted: true }
  | { readonly granted: false; readonly retryAfterMs: number };

/**
 * Classic token bucket. `capacity` is the burst allowance; `refillPerSecond` is
 * the sustained CPS. Deliberately has no timers and no async — the caller decides
 * what to do with `retryAfterMs`, which is what makes it workflow-drivable.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
  }

  /** Peek without consuming — used to signal backpressure before evaluating a lead. */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  tryConsume(nowMs: number): BucketOutcome {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { granted: true };
    }
    const deficit = 1 - this.tokens;
    return { granted: false, retryAfterMs: Math.ceil((deficit / this.refillPerSecond) * 1000) };
  }
}

/**
 * Buckets keyed by (trunk, destination country).
 *
 * Per-trunk because that's the entity a carrier blocks; per-destination-country
 * because international routes have their own, usually much lower, CPS ceilings —
 * and a spike into one country must not consume the whole trunk's headroom.
 */
export class TrunkRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  static key(trunkId: string, destinationCountry: string): string {
    return `${trunkId}::${destinationCountry.toUpperCase()}`;
  }

  private bucket(
    trunkId: string,
    country: string,
    capacity: number,
    cps: number,
    nowMs: number,
  ): TokenBucket {
    const key = TrunkRateLimiter.key(trunkId, country);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.capacity !== capacity || bucket.refillPerSecond !== cps) {
      bucket = new TokenBucket(capacity, cps, nowMs);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  tryConsume(
    trunkId: string,
    country: string,
    opts: { capacity: number; callsPerSecond: number },
    nowMs: number,
  ): BucketOutcome {
    return this.bucket(trunkId, country, opts.capacity, opts.callsPerSecond, nowMs).tryConsume(
      nowMs,
    );
  }
}

// ===========================================================================
// 3. Pure decision helpers
// ===========================================================================

export type CallingWindow = ComplianceProfile['callingWindows'][number];

/**
 * PURE. The effective calling windows are the INTERSECTION of the compliance
 * profile's (legally binding) windows and the campaign's (operational) ones.
 * A campaign can narrow the window; it can never widen it.
 */
export function effectiveCallingWindows(
  profileWindows: readonly CallingWindow[],
  campaignWindows: readonly CallingWindow[],
): CallingWindow[] {
  if (campaignWindows.length === 0) return [...profileWindows];
  if (profileWindows.length === 0) return [...campaignWindows];

  const out: CallingWindow[] = [];
  for (const p of profileWindows) {
    for (const c of campaignWindows) {
      if (p.dayOfWeek !== c.dayOfWeek) continue;
      const startHour = Math.max(p.startHour, c.startHour);
      const endHour = Math.min(p.endHour, c.endHour);
      if (startHour < endHour) out.push({ dayOfWeek: p.dayOfWeek, startHour, endHour });
    }
  }
  return out;
}

/**
 * PURE. The effective compliance profile for one dispatch.
 *
 * Attempt cap: the LOWER of the compliance profile's cap and the campaign's retry
 * policy. A campaign cannot buy its way past the compliance cap.
 */
export function effectiveProfile(
  profile: ComplianceProfile,
  campaign: Pick<Campaign, 'retryPolicy' | 'schedule'>,
): ComplianceProfile {
  return {
    ...profile,
    maxAttemptsPerLead: Math.min(profile.maxAttemptsPerLead, campaign.retryPolicy.maxAttempts),
    callingWindows: effectiveCallingWindows(profile.callingWindows, campaign.schedule.windows),
  };
}

/** PURE. Is this consent proof present, and still valid at `at`? */
export function consentProofValid(proof: ConsentProof | null, at: Date): boolean {
  if (!proof) return false;
  if (!proof.expiresAt) return true;
  return new Date(proof.expiresAt).getTime() > at.getTime();
}

/**
 * PURE. The TCPA gate from docs/13 §3, evaluated independently of the chain.
 *
 * This duplicates the chain's `consent_proof` rule on purpose. It is defence in
 * depth: if the chain is ever reordered, misconfigured, or a rule is dropped, the
 * single highest-liability check still runs. Returns a reason string when the dial
 * must be refused, or null.
 */
export function consentGate(
  profile: ComplianceProfile,
  lead: Pick<Lead, 'consentProof' | 'country' | 'isMobile'>,
  at: Date,
): string | null {
  if (!profile.requireConsentProof) return null;
  if (consentProofValid(lead.consentProof, at)) return null;

  const mobileNote =
    lead.country.toUpperCase() === 'US' && lead.isMobile
      ? ' (US mobile: FCC treats AI voice as "artificial" under the TCPA — prior express WRITTEN consent required)'
      : '';
  return `refusing to dial: no valid proof of prior express written consent on file${mobileNote}`;
}

/**
 * PURE. Exponential backoff: base * factor^(attempt-1), clamped.
 * `attemptNumber` is 1-based and is the attempt that just FAILED.
 */
export function backoffSeconds(policy: RetryPolicy, attemptNumber: number): number {
  const raw = policy.backoffBaseSeconds * Math.pow(policy.backoffFactor, Math.max(0, attemptNumber - 1));
  return Math.min(policy.maxBackoffSeconds, Math.round(raw));
}

/**
 * PURE. Next moment the calling window opens, searching forward hour by hour.
 * Returns null when no window is configured or none opens within the horizon.
 */
export function nextWindowOpening(
  windows: readonly CallingWindow[],
  from: Date,
  country: string,
  timezone: string | null,
  horizonHours = 24 * 8,
): Date | null {
  if (windows.length === 0) return null;
  for (let i = 1; i <= horizonHours; i += 1) {
    const at = new Date(from.getTime() + i * 3_600_000);
    const { dayOfWeek, hour } = calleeLocalTime(at, country, timezone);
    const open = windows.some(
      (w) => w.dayOfWeek === dayOfWeek && hour >= w.startHour && hour < w.endHour,
    );
    if (open) return at;
  }
  return null;
}

/** PURE. Assemble the chain's input. No I/O, no clock reads. */
export function buildDispatchContext(input: {
  profile: ComplianceProfile;
  lead: Pick<Lead, 'country' | 'state' | 'timezone' | 'attemptCount' | 'consentProof' | 'onDncList'>;
  onDncList: boolean;
  at: Date;
}): DispatchContext {
  const local = calleeLocalTime(input.at, input.lead.country, input.lead.timezone);
  return {
    profile: input.profile,
    calleeCountry: input.lead.country.toUpperCase(),
    calleeState: input.lead.state,
    calleeLocalTime: { dayOfWeek: local.dayOfWeek, hour: local.hour },
    onDncList: input.onDncList || input.lead.onDncList,
    attemptsSoFar: input.lead.attemptCount,
    hasConsentProof: consentProofValid(input.lead.consentProof, input.at),
    isOutbound: true,
  };
}

/** Which blocks are permanent for this lead vs. worth retrying later. */
const TERMINAL_BLOCK_RULES = new Set(['dnc', 'consent_proof', 'jurisdiction']);
const EXHAUSTED_BLOCK_RULES = new Set(['attempts']);

// ===========================================================================
// 4. Side effects — the only impure surface
// ===========================================================================

export interface PlaceCallRequest {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly leadId: string;
  readonly agentId: string;
  readonly fromE164: string;
  readonly toE164: string;
  readonly trunkId: string;
  readonly attemptNumber: number;
  /** Recording requires all-party consent in this jurisdiction. */
  readonly twoPartyConsentRequired: boolean;
  readonly aiDisclosureRequired: boolean;
}

export interface PlaceCallResult {
  readonly callId: string;
}

/**
 * Every impure operation the dialer performs. This is the Temporal activity
 * interface in all but name — when the workflow engine lands, an implementation of
 * this becomes the activity stubs and nothing above this line changes.
 */
export interface DialerEffects {
  now(): Date;
  newAuditId(): string;
  /** External DNC/DND registry screening (US national DNC, TPS, Bloctel, …). */
  isOnDnc(input: { e164: string; country: string; registries: readonly string[] }): Promise<boolean>;
  placeCall(request: PlaceCallRequest): Promise<PlaceCallResult>;
  recordAudit(entry: DispatchAuditEntry): Promise<void>;
}

// ===========================================================================
// 5. Results
// ===========================================================================

export type DialStatus = 'dispatched' | 'blocked' | 'throttled' | 'not_running';

export interface DialResult {
  readonly status: DialStatus;
  readonly leadId: string;
  readonly reason: string;
  /** Set when status is 'dispatched'. */
  readonly callId?: string;
  /** Set when status is 'throttled' — how long the caller should wait. */
  readonly retryAfterMs?: number;
  /** Set when the lead is rescheduled rather than suppressed. */
  readonly nextAttemptAt?: string;
  readonly decision: DispatchDecision;
  readonly rulesApplied: ReadonlyArray<{ key: string; action: string; reason: string }>;
  readonly calleeLocalTime: CalleeLocalTime;
  readonly auditId: string | null;
}

export interface DispatchParams {
  campaign: Campaign;
  lead: Lead;
  fromNumber: PhoneNumber;
  /** The WORKSPACE's compliance profile (docs/12 §4) — never the org's, never a global. */
  profile: ComplianceProfile;
}

// ===========================================================================
// 6. Dialer
// ===========================================================================

export class Dialer {
  private readonly limiter = new TrunkRateLimiter();

  constructor(
    private readonly chain: HandlerChain<DispatchDecision, DispatchContext>,
    private readonly effects: DialerEffects,
    private readonly leads: LeadRepository,
  ) {}

  /**
   * Evaluate and, if permitted, dispatch a single lead.
   *
   * Ordering is deliberate:
   *   1. campaign state       — cheap, no decision recorded
   *   2. consent gate         — pure, highest liability, fails closed
   *   3. compliance chain     — the full rule set
   *   4. audit                — ALWAYS, allowed or blocked
   *   5. token bucket         — pacing; a throttle defers, it does not decide
   *   6. originate            — the only place a call is placed
   *
   * The compliance decision is audited before pacing is consulted, so the audit
   * answers "were we permitted to call?" independently of "did we get around to
   * it?". A throttled dial therefore has an audit row with allowed=true and no
   * call — which is the honest record of what happened.
   */
  async dispatch(scope: WorkspaceScope, params: DispatchParams): Promise<DialResult> {
    const { campaign, lead, fromNumber, profile } = params;
    const at = this.effects.now();
    const local = calleeLocalTime(at, lead.country, lead.timezone);

    if (campaign.status !== 'running') {
      return {
        status: 'not_running',
        leadId: lead.id,
        reason: `campaign is ${campaign.status}`,
        decision: { allowed: false, reason: `campaign is ${campaign.status}` },
        rulesApplied: [],
        calleeLocalTime: local,
        auditId: null,
      };
    }

    const effective = effectiveProfile(profile, campaign);

    // -- 2. Consent gate (defence in depth over the chain's own rule) --------
    const consentFailure = consentGate(effective, lead, at);

    // -- 3. Compliance chain -------------------------------------------------
    const onDnc =
      lead.onDncList ||
      (await this.effects.isOnDnc({
        e164: lead.e164,
        country: lead.country,
        registries: effective.dncRegistries,
      }));

    const ctx = buildDispatchContext({ profile: effective, lead, onDncList: onDnc, at });
    const chainResult = await this.chain.run({ allowed: true, reason: 'ok' }, ctx);

    const rulesApplied = consentFailure
      ? [
          { key: 'consent_gate', action: 'block', reason: consentFailure },
          ...chainResult.applied.map((a) => ({ key: a.key, action: a.action, reason: a.reason })),
        ]
      : chainResult.applied.map((a) => ({ key: a.key, action: a.action, reason: a.reason }));

    const blocked = Boolean(consentFailure) || chainResult.blocked;
    const decision: DispatchDecision = blocked
      ? { allowed: false, reason: consentFailure ?? chainResult.value.reason }
      : { allowed: true, reason: 'all compliance checks passed' };

    // -- 4. Audit — unconditional -------------------------------------------
    const auditId = await this.audit(scope, {
      campaign,
      lead,
      fromNumber,
      profile: effective,
      decision,
      rulesApplied,
      local,
      at,
    });

    if (blocked) {
      await this.applyBlock(scope, effective.callingWindows, lead, rulesApplied, at);
      return {
        status: 'blocked',
        leadId: lead.id,
        reason: decision.reason,
        decision,
        rulesApplied,
        calleeLocalTime: local,
        auditId,
      };
    }

    // -- 5. Pacing -----------------------------------------------------------
    const bucket = this.limiter.tryConsume(
      fromNumber.trunkId,
      lead.country,
      { capacity: campaign.pacing.burst, callsPerSecond: campaign.pacing.callsPerSecond },
      at.getTime(),
    );
    if (!bucket.granted) {
      const nextAttemptAt = new Date(at.getTime() + bucket.retryAfterMs).toISOString();
      await this.leads.update(scope, lead.id, {
        lifecycle: 'retry_scheduled',
        nextAttemptAt,
      });
      return {
        status: 'throttled',
        leadId: lead.id,
        reason: `trunk ${fromNumber.trunkId} -> ${lead.country} at CPS limit`,
        retryAfterMs: bucket.retryAfterMs,
        nextAttemptAt,
        decision,
        rulesApplied,
        calleeLocalTime: local,
        auditId,
      };
    }

    // -- 6. Originate --------------------------------------------------------
    const attemptNumber = lead.attemptCount + 1;
    const call = await this.effects.placeCall({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      campaignId: campaign.id,
      leadId: lead.id,
      agentId: campaign.agentId,
      fromE164: fromNumber.e164,
      toE164: lead.e164,
      trunkId: fromNumber.trunkId,
      attemptNumber,
      twoPartyConsentRequired: effective.consentModel === 'two_party',
      aiDisclosureRequired: effective.aiDisclosureRequired,
    });

    await this.leads.update(scope, lead.id, {
      lifecycle: 'in_flight',
      attemptCount: attemptNumber,
      lastAttemptAt: at.toISOString(),
      nextAttemptAt: null,
    });

    return {
      status: 'dispatched',
      leadId: lead.id,
      reason: decision.reason,
      callId: call.callId,
      decision,
      rulesApplied,
      calleeLocalTime: local,
      auditId,
    };
  }

  /**
   * Drain due leads for a campaign, one pacing tick.
   *
   * Kept as a plain loop with no timers: in the Temporal design (docs/05 layer 3)
   * this becomes a workflow that calls `dispatch` as an activity and sleeps on the
   * returned `retryAfterMs`. Stops at the first throttle so the CPS ceiling is
   * respected across the whole batch.
   */
  async tick(
    scope: WorkspaceScope,
    params: { campaign: Campaign; fromNumber: PhoneNumber; profile: ComplianceProfile; max?: number },
  ): Promise<DialResult[]> {
    const { campaign, fromNumber, profile } = params;
    const max = params.max ?? Math.max(1, Math.ceil(campaign.pacing.callsPerSecond));
    const nowIso = this.effects.now().toISOString();
    const due = await this.leads.claimDueLeads(scope, campaign.id, nowIso, max);

    const results: DialResult[] = [];
    for (const lead of due) {
      const result = await this.dispatch(scope, { campaign, lead, fromNumber, profile });
      results.push(result);
      if (result.status === 'throttled') break;
    }
    return results;
  }

  /**
   * Post-call outcome. Applies the retry policy with exponential backoff, or
   * retires the lead when the attempt cap is reached.
   */
  async recordOutcome(
    scope: WorkspaceScope,
    params: { campaign: Campaign; lead: Lead; profile: ComplianceProfile; outcome: LeadOutcome },
  ): Promise<Lead> {
    const { campaign, lead, profile, outcome } = params;
    const at = this.effects.now();
    const effective = effectiveProfile(profile, campaign);

    if (outcome === 'do_not_call') {
      return this.leads.update(scope, lead.id, {
        lastOutcome: outcome,
        lastAttemptAt: at.toISOString(),
        lifecycle: 'suppressed',
        onDncList: true,
        nextAttemptAt: null,
      });
    }

    if (outcome === 'answered') {
      return this.leads.update(scope, lead.id, {
        lastOutcome: outcome,
        lastAttemptAt: at.toISOString(),
        lifecycle: 'completed',
        nextAttemptAt: null,
      });
    }

    const retryable = campaign.retryPolicy.retryOn as readonly string[];
    const capped = lead.attemptCount >= effective.maxAttemptsPerLead;
    if (capped || !retryable.includes(outcome)) {
      return this.leads.update(scope, lead.id, {
        lastOutcome: outcome,
        lastAttemptAt: at.toISOString(),
        lifecycle: capped ? 'exhausted' : 'completed',
        nextAttemptAt: null,
      });
    }

    const delaySec = backoffSeconds(campaign.retryPolicy, lead.attemptCount);
    const earliest = new Date(at.getTime() + delaySec * 1000);
    // Never schedule a retry into a closed window — push to the next opening.
    const windows = effective.callingWindows;
    const { dayOfWeek, hour } = calleeLocalTime(earliest, lead.country, lead.timezone);
    const open =
      windows.length === 0 ||
      windows.some((w) => w.dayOfWeek === dayOfWeek && hour >= w.startHour && hour < w.endHour);
    const scheduled = open
      ? earliest
      : (nextWindowOpening(windows, earliest, lead.country, lead.timezone) ?? earliest);

    return this.leads.update(scope, lead.id, {
      lastOutcome: outcome,
      lastAttemptAt: at.toISOString(),
      lifecycle: 'retry_scheduled',
      nextAttemptAt: scheduled.toISOString(),
    });
  }

  // -------------------------------------------------------------------------

  private async audit(
    scope: WorkspaceScope,
    input: {
      campaign: Campaign;
      lead: Lead;
      fromNumber: PhoneNumber;
      profile: ComplianceProfile;
      decision: DispatchDecision;
      rulesApplied: ReadonlyArray<{ key: string; action: string; reason: string }>;
      local: CalleeLocalTime;
      at: Date;
    },
  ): Promise<string> {
    const entry: DispatchAuditEntry = Object.freeze({
      id: this.effects.newAuditId(),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      campaignId: input.campaign.id,
      leadId: input.lead.id,
      decidedAt: input.at.toISOString(),
      decidedBy: scope.userId,
      destination: input.lead.e164,
      destinationCountry: input.lead.country.toUpperCase(),
      fromNumberId: input.fromNumber.id,
      trunkId: input.fromNumber.trunkId,
      allowed: input.decision.allowed,
      reason: input.decision.reason,
      rulesApplied: input.rulesApplied.map((r) => ({ ...r })),
      calleeLocalTime: { dayOfWeek: input.local.dayOfWeek, hour: input.local.hour },
      attemptNumber: input.lead.attemptCount + 1,
      hadConsentProof: consentProofValid(input.lead.consentProof, input.at),
      consentProofRef: input.lead.consentProof?.ref ?? null,
      profileSnapshot: {
        jurisdictions: [...input.profile.jurisdictions],
        requireConsentProof: input.profile.requireConsentProof,
        maxAttemptsPerLead: input.profile.maxAttemptsPerLead,
        consentModel: input.profile.consentModel,
      },
    });

    await this.effects.recordAudit(entry);
    return entry.id;
  }

  /**
   * A block is either permanent for this lead (DNC, no consent, jurisdiction not
   * permitted) or temporal (outside the calling window). Only the latter is
   * rescheduled — re-dialing a DNC number on a timer is precisely the violation.
   */
  private async applyBlock(
    scope: WorkspaceScope,
    windows: readonly CallingWindow[],
    lead: Lead,
    rulesApplied: ReadonlyArray<{ key: string }>,
    at: Date,
  ): Promise<void> {
    const keys = new Set(rulesApplied.map((r) => r.key));
    const terminal = [...keys].some(
      (k) => TERMINAL_BLOCK_RULES.has(k) || k === 'consent_gate',
    );

    if (terminal) {
      await this.leads.update(scope, lead.id, {
        lifecycle: 'suppressed',
        lastOutcome: keys.has('dnc') ? 'do_not_call' : 'blocked_compliance',
        nextAttemptAt: null,
      });
      return;
    }

    if ([...keys].some((k) => EXHAUSTED_BLOCK_RULES.has(k))) {
      await this.leads.update(scope, lead.id, {
        lifecycle: 'exhausted',
        lastOutcome: 'blocked_compliance',
        nextAttemptAt: null,
      });
      return;
    }

    // Calling-window (or anything else transient): reschedule to the next opening.
    const next = nextWindowOpening(windows, at, lead.country, lead.timezone);
    await this.leads.update(scope, lead.id, {
      lifecycle: 'retry_scheduled',
      lastOutcome: 'blocked_compliance',
      nextAttemptAt: (next ?? new Date(at.getTime() + 3_600_000)).toISOString(),
    });
  }
}
