/**
 * Number service — inventory, purchase, release, assignment, reputation.
 *
 * Two things here are load-bearing beyond CRUD:
 *
 * 1. **Reputation** (docs/03 5.1 / §I). Outbound answer rate is a business metric.
 *    A number carries a reputation status that the dialer reads before every dial;
 *    flagged numbers get rotated out rather than silently burning the campaign.
 *
 * 2. **Local-presence regulation** (docs/13 §5). Several EU countries require a
 *    local address or legal entity before you may hold a number. Discovering that
 *    as an opaque 422 from the carrier three weeks into an EU rollout is exactly
 *    the failure this service exists to prevent, so we check BEFORE we order and
 *    return an error that says what to do about it.
 */

import { newId } from '../domain/ids.js';
import { require_, type TenantScope, type WorkspaceScope } from '../domain/tenant.js';
import {
  availableNumberSchema,
  phoneNumberSchema,
  type AvailableNumber,
  type PhoneNumber,
  type PurchaseNumberInput,
  type ReputationStatus,
  type SearchNumbersQuery,
} from '../domain/telephony-schemas.js';
import {
  LocalPresenceRequiredError,
  type PhoneNumberListOptions,
  type PhoneNumberRepository,
} from '../repositories/telephony-repository.js';
import {
  ConflictError,
  NotFoundError,
  type AgentRepository,
  type OrganizationRepository,
} from '../repositories/types.js';

// ---------------------------------------------------------------------------
// Local-presence regulation
// ---------------------------------------------------------------------------

export interface LocalPresenceRule {
  /** What the regulator actually wants, in plain language. */
  requirements: string[];
  /** Does an in-country address suffice, or is a registered entity needed? */
  level: 'local_address' | 'local_entity';
  regulator: string;
  notes: string;
}

/**
 * ⚖️ DIRECTIONAL — verify with counsel and with each carrier before this gates real
 * ordering. Held as data, not code, so legal can correct it without a deploy
 * (same principle as `JURISDICTIONS` in compliance.ts).
 *
 * Source: docs/13 §5 — "several countries (Germany, Italy, Spain among them) require
 * a local address or entity to hold numbers".
 */
export const LOCAL_PRESENCE_RULES: Record<string, LocalPresenceRule> = {
  DE: {
    level: 'local_address',
    regulator: 'Bundesnetzagentur',
    requirements: [
      'A verifiable service address in Germany (Ladungsfähige Anschrift)',
      'Proof of address: utility bill, lease, or Handelsregister extract, dated within 3 months',
      'For geographic (local) numbers, the address must be inside the number range’s area',
    ],
    notes: 'Address must be in the same local area as a geographic number range.',
  },
  IT: {
    level: 'local_entity',
    regulator: 'AGCOM / MISE',
    requirements: [
      'An Italian legal entity or an EU entity with an Italian fiscal representative',
      'Codice Fiscale or Partita IVA',
      'A verifiable Italian service address',
    ],
    notes: 'Italy is among the strictest; expect entity setup lead time.',
  },
  ES: {
    level: 'local_address',
    regulator: 'CNMC',
    requirements: [
      'A verifiable Spanish service address',
      'NIF/CIF for the holder',
      'Proof of address dated within 3 months',
    ],
    notes: '',
  },
  FR: {
    level: 'local_address',
    regulator: 'ARCEP',
    requirements: [
      'A verifiable French service address',
      'SIRET or EU VAT number for the holder',
    ],
    notes: 'Geographic numbers are tied to the address’s zone.',
  },
  BE: {
    level: 'local_address',
    regulator: 'BIPT',
    requirements: ['A verifiable Belgian service address', 'EU VAT number'],
    notes: '',
  },
  CH: {
    level: 'local_entity',
    regulator: 'OFCOM (CH)',
    requirements: [
      'A Swiss legal entity or a Swiss-domiciled representative',
      'A verifiable Swiss service address',
    ],
    notes: 'Non-EU; separate from the EU rules above.',
  },
  AT: {
    level: 'local_address',
    regulator: 'RTR',
    requirements: ['A verifiable Austrian service address', 'EU VAT number'],
    notes: '',
  },
  PL: {
    level: 'local_address',
    regulator: 'UKE',
    requirements: ['A verifiable Polish service address', 'EU VAT number'],
    notes: '',
  },
};

export function localPresenceRuleFor(country: string): LocalPresenceRule | null {
  return LOCAL_PRESENCE_RULES[country.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Upstream number provider (stub)
// ---------------------------------------------------------------------------

/**
 * The carrier-facing side, behind an interface so the service stays testable and
 * so Twilio/Telnyx/Sinch adapters can be registered in the container later.
 */
export interface NumberProvider {
  readonly key: string;
  search(query: SearchNumbersQuery): Promise<AvailableNumber[]>;
  purchase(e164: string, country: string): Promise<{ carrier: string; monthlyCostUsd: number }>;
  release(e164: string): Promise<void>;
  /**
   * Reputation lookup across the analytics providers that drive "Spam Likely".
   * STUB — see `MockNumberProvider.checkReputation`.
   */
  checkReputation(e164: string): Promise<{
    status: ReputationStatus;
    score: number | null;
    sources: string[];
  }>;
}

const DIAL_CODES: Record<string, string> = {
  US: '+1', CA: '+1', GB: '+44', DE: '+49', FR: '+33', ES: '+34', IT: '+39',
  NL: '+31', IE: '+353', BE: '+32', AT: '+43', CH: '+41', PL: '+48', SE: '+46',
  DK: '+45', NO: '+47', FI: '+358', PT: '+351',
};

/** Cost model is directional; real pricing comes from the carrier's catalogue. */
const MONTHLY_COST_USD: Record<string, number> = {
  US: 1.15, CA: 1.15, GB: 1.0, DE: 1.5, FR: 1.4, ES: 1.4, IT: 1.6,
  NL: 1.3, IE: 1.2, BE: 1.4, AT: 1.5, CH: 2.0, PL: 1.2,
};

export class MockNumberProvider implements NumberProvider {
  readonly key = 'mock-numbers';

  async search(query: SearchNumbersQuery): Promise<AvailableNumber[]> {
    const cc = query.country.toUpperCase();
    const dial = DIAL_CODES[cc] ?? '+1';
    const area = query.areaCode ?? '555';
    const requiresLocalAddress = localPresenceRuleFor(cc) !== null;

    return Array.from({ length: query.limit }, (_, i) =>
      availableNumberSchema.parse({
        e164: `${dial}${area}${String(1_000_000 + i * 7).slice(0, 7)}`,
        country: cc,
        numberType: query.numberType ?? 'local',
        capabilities: query.capabilities,
        carrier: this.key,
        monthlyCostUsd: MONTHLY_COST_USD[cc] ?? 1.5,
        setupCostUsd: 0,
        requiresLocalAddress,
      } satisfies Record<string, unknown>),
    );
  }

  async purchase(_e164: string, country: string) {
    return { carrier: this.key, monthlyCostUsd: MONTHLY_COST_USD[country.toUpperCase()] ?? 1.5 };
  }

  async release(_e164: string) {
    /* no-op */
  }

  /**
   * STUB. The real implementation (docs/03 §I) polls the major call-analytics
   * providers (First Orion, Hiya, TNS, and the carrier's own feed), correlates
   * their labels with our own answer-rate telemetry, and writes back a status.
   *
   * Until that exists this returns `unknown`, and the dialer treats `unknown` as
   * dialable — reputation gating fails OPEN because a missing feed must not stop
   * a customer's traffic. The compliance gate, by contrast, fails CLOSED.
   */
  async checkReputation(_e164: string) {
    return { status: 'unknown' as ReputationStatus, score: null, sources: [] };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Reputation states the dialer refuses to originate from. */
export const UNDIALABLE_REPUTATION: ReadonlySet<ReputationStatus> = new Set<ReputationStatus>([
  'flagged',
  'blocked',
]);

export class NumberService {
  constructor(
    private readonly numbers: PhoneNumberRepository,
    private readonly agents: AgentRepository,
    private readonly orgs: OrganizationRepository,
    private readonly provider: NumberProvider = new MockNumberProvider(),
  ) {}

  async list(scope: WorkspaceScope, opts?: PhoneNumberListOptions) {
    require_(scope, 'workspace:read');
    return this.numbers.list(scope, opts);
  }

  async get(scope: WorkspaceScope, numberId: string): Promise<PhoneNumber> {
    require_(scope, 'workspace:read');
    const number = await this.numbers.get(scope, numberId);
    if (!number) throw new NotFoundError('phone number', numberId);
    return number;
  }

  /**
   * Search upstream inventory. Annotates each result with the local-presence
   * requirement so the dashboard can warn BEFORE the user clicks buy.
   */
  async search(scope: WorkspaceScope, query: SearchNumbersQuery): Promise<{
    items: AvailableNumber[];
    localPresence: LocalPresenceRule | null;
  }> {
    require_(scope, 'workspace:read');
    const items = await this.provider.search(query);
    return { items, localPresence: localPresenceRuleFor(query.country) };
  }

  /**
   * Purchase and register a number.
   *
   * Order of checks matters: regulatory eligibility is verified before we touch
   * the carrier, so a blocked purchase costs nothing and produces an error the
   * customer can act on.
   */
  async purchase(scope: WorkspaceScope, input: PurchaseNumberInput): Promise<PhoneNumber> {
    require_(scope, 'number:manage');

    const country = input.country.toUpperCase();
    await this.assertLocalPresence(scope, country);

    if (await this.numbers.existsInOrg(scope, input.e164)) {
      throw new ConflictError(`number already held by this organization: ${input.e164}`);
    }

    if (input.agentId) {
      const agent = await this.agents.get(scope, input.agentId);
      if (!agent) throw new NotFoundError('agent', input.agentId);
    }

    const { carrier, monthlyCostUsd } = await this.provider.purchase(input.e164, country);
    const now = new Date().toISOString();

    const number = phoneNumberSchema.parse({
      id: newId('phoneNumber'),
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      e164: input.e164,
      country,
      numberType: 'local',
      capabilities: ['voice'],
      carrier,
      trunkId: input.trunkId ?? `trunk-${country.toLowerCase()}`,
      // Attestation is assigned by the originating carrier once the number is
      // in our OCN and the customer is vetted. Never claim A-level ourselves.
      attestation: 'none',
      cnamLabel: input.cnamLabel,
      reputation: { status: 'unknown', score: null, sources: [], lastCheckedAt: null },
      monthlyCostUsd,
      assignedAgentId: input.agentId ?? null,
      status: 'active',
      purchasedAt: now,
      releasedAt: null,
    } satisfies Record<string, unknown>);

    return this.numbers.create(scope, number);
  }

  /** Release back to the carrier. Soft-deletes locally so call records resolve. */
  async release(scope: WorkspaceScope, numberId: string): Promise<void> {
    require_(scope, 'number:manage');
    const number = await this.get(scope, numberId);
    await this.provider.release(number.e164);
    await this.numbers.delete(scope, numberId);
  }

  /** Assign (or, with null, unassign) the agent that handles this number. */
  async assign(
    scope: WorkspaceScope,
    numberId: string,
    agentId: string | null,
  ): Promise<PhoneNumber> {
    require_(scope, 'number:manage');
    await this.get(scope, numberId);

    if (agentId) {
      const agent = await this.agents.get(scope, agentId);
      if (!agent) throw new NotFoundError('agent', agentId);
      if (agent.status === 'archived') {
        throw new ConflictError('cannot assign a number to an archived agent');
      }
    }
    return this.numbers.update(scope, numberId, { assignedAgentId: agentId });
  }

  /**
   * Refresh reputation from the analytics feed and persist it.
   *
   * STUBBED behind `NumberProvider.checkReputation` (docs/03 §I). Exposed as an
   * explicit method because the production version is a scheduled sweep, not a
   * request-path call — it will be driven by the same workflow layer as the dialer.
   */
  async refreshReputation(scope: WorkspaceScope, numberId: string): Promise<PhoneNumber> {
    require_(scope, 'number:manage');
    const number = await this.get(scope, numberId);
    const result = await this.provider.checkReputation(number.e164);
    return this.numbers.update(scope, numberId, {
      reputation: {
        status: result.status,
        score: result.score,
        sources: result.sources,
        lastCheckedAt: new Date().toISOString(),
      },
    });
  }

  /** Numbers a campaign may originate from right now. Flagged numbers are excluded. */
  async dialableNumbers(scope: WorkspaceScope, numberIds: string[]): Promise<PhoneNumber[]> {
    require_(scope, 'workspace:read');
    const out: PhoneNumber[] = [];
    for (const id of numberIds) {
      const number = await this.numbers.get(scope, id);
      if (!number) continue;
      if (number.status !== 'active') continue;
      if (UNDIALABLE_REPUTATION.has(number.reputation.status)) continue;
      out.push(number);
    }
    return out;
  }

  // -------------------------------------------------------------------------

  /**
   * docs/13 §5. Throws a `LocalPresenceRequiredError` carrying the concrete list
   * of what the regulator wants — an error the customer can act on without
   * opening a support ticket.
   */
  private async assertLocalPresence(scope: TenantScope, country: string): Promise<void> {
    const rule = localPresenceRuleFor(country);
    if (!rule) return;

    const org = await this.orgs.get(scope);
    const addressCountry = org?.address?.country?.toUpperCase();
    if (addressCountry === country) return;

    const held = addressCountry
      ? `Your organization's registered address is in ${addressCountry}.`
      : 'Your organization has no registered address on file.';

    throw new LocalPresenceRequiredError(
      country,
      [
        `${country} numbers cannot be purchased yet: ${rule.regulator} requires a ` +
          `${rule.level === 'local_entity' ? 'local legal entity' : 'local service address'} ` +
          `for the number holder. ${held}`,
        `To proceed, add the following to your organization profile and re-try:`,
        ...rule.requirements.map((r, i) => `  ${i + 1}. ${r}`),
        rule.notes ? `Note: ${rule.notes}` : '',
        'This is a regulatory requirement, not a platform limitation — see docs/13 §5.',
      ]
        .filter(Boolean)
        .join('\n'),
      rule.requirements,
    );
  }
}
