/**
 * Compliance defaults and pre-dispatch checks. docs/13 §2.
 *
 * ⚠️ The jurisdiction data below is DIRECTIONAL and must be reviewed by counsel
 * before it gates real traffic. It is structured so the rules live in data, not in
 * code, precisely so legal can correct it without a deploy.
 *
 * Implemented as a Chain of Responsibility so each check is independently testable
 * and the trace shows exactly which rule blocked a call.
 */

import { HandlerChain, type ChainHandler } from '../core/patterns/chain.js';
import type { ComplianceProfile } from '../domain/schemas.js';

// ---------------------------------------------------------------------------
// Jurisdiction defaults
// ---------------------------------------------------------------------------

export interface JurisdictionRule {
  /** Recording consent model. */
  consentModel: 'one_party' | 'two_party';
  /** EU AI Act / state-law style transparency obligation. */
  aiDisclosureRequired: boolean;
  /** Default permitted calling window in the callee's local time. */
  callingWindow: { startHour: number; endHour: number };
  /** DNC/DND registries that must be checked. */
  dncRegistries: string[];
  /** Whether outbound to mobiles needs documented prior express written consent. */
  requireConsentProof: boolean;
  /** Label for the org's tax identifier field. */
  taxIdLabel: string;
  notes: string;
}

/**
 * Defaults per country. Sources: GDPR/ePrivacy for the EU, TCPA/FCC and state
 * wiretapping statutes for the US. ⚖️ Verify before production use.
 */
export const JURISDICTIONS: Record<string, JurisdictionRule> = {
  US: {
    consentModel: 'one_party', // federal baseline; several states are stricter — see US_STATE_TWO_PARTY
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 }, // TCPA 8am–9pm callee local time
    dncRegistries: ['us_national_dnc', 'internal'],
    requireConsentProof: true, // FCC treats AI voices as "artificial" under TCPA
    taxIdLabel: 'EIN',
    notes: 'AI voice outbound to mobiles generally needs prior express written consent.',
  },
  GB: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 },
    dncRegistries: ['uk_tps', 'uk_ctps', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'VAT number',
    notes: 'ICO guidance applies; TPS/CTPS screening required for marketing calls.',
  },
  DE: {
    consentModel: 'two_party', // recording generally requires all-party consent
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['internal'],
    requireConsentProof: true, // UWG: prior express consent for marketing calls
    taxIdLabel: 'USt-IdNr.',
    notes: 'Strict. Works-council approval may be required for employee-facing use.',
  },
  FR: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 10, endHour: 20 },
    dncRegistries: ['fr_bloctel', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'N° TVA',
    notes: 'Bloctel screening required; statutory calling-window restrictions apply.',
  },
  ES: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['es_lista_robinson', 'internal'],
    requireConsentProof: true,
    taxIdLabel: 'NIF/CIF',
    notes: 'Lista Robinson screening.',
  },
  IT: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['it_rpo', 'internal'],
    requireConsentProof: true,
    taxIdLabel: 'Partita IVA',
    notes: 'Registro Pubblico delle Opposizioni screening.',
  },
  NL: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['internal'],
    requireConsentProof: true,
    taxIdLabel: 'BTW-nummer',
    notes: '',
  },
  IE: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['ie_ndd', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'VAT number',
    notes: '',
  },
};

/** US states generally requiring all-party consent to record. ⚖️ Verify. */
export const US_STATE_TWO_PARTY = [
  'CA', 'FL', 'WA', 'PA', 'IL', 'MD', 'MA', 'MT', 'NH', 'CT', 'DE', 'MI', 'NV', 'OR',
];

/** EU/EEA — drives GDPR handling and residency defaults. */
export const EU_COUNTRIES = [
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT',
  'LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO',
];

export function isEu(country: string): boolean {
  return EU_COUNTRIES.includes(country.toUpperCase());
}

export function taxIdLabelFor(country: string): string {
  return JURISDICTIONS[country.toUpperCase()]?.taxIdLabel ?? (isEu(country) ? 'VAT number' : 'Tax ID');
}

/**
 * Build a starting compliance profile for a workspace from its country.
 *
 * Defaults are deliberately CONSERVATIVE: where a country is unknown we assume
 * two-party consent, disclosure required, and consent proof required. Failing
 * closed is the only defensible default in a regulated domain.
 */
export function defaultComplianceProfile(country: string): ComplianceProfile {
  const cc = country.toUpperCase();
  const rule = JURISDICTIONS[cc];

  const consentModel = rule?.consentModel ?? 'two_party';
  const window = rule?.callingWindow ?? { startHour: 9, endHour: 20 };

  return {
    jurisdictions: [cc],
    consentModel,
    aiDisclosureRequired: rule?.aiDisclosureRequired ?? true,
    aiDisclosureText: defaultDisclosureText(cc),
    // Mon–Sat by default; Sunday calling is off unless explicitly enabled.
    callingWindows: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      startHour: window.startHour,
      endHour: window.endHour,
    })),
    dncRegistries: rule?.dncRegistries ?? ['internal'],
    maxAttemptsPerLead: 3,
    // GDPR data-minimisation pushes retention down in the EU.
    retentionDays: isEu(cc) ? 90 : 365,
    piiRedaction: true,
    requireConsentProof: rule?.requireConsentProof ?? true,
    // NEVER default-on. docs/14 §5: claiming HIPAA readiness without a signed BAA
    // on every sub-processor is a misrepresentation, so this is opt-in only and
    // gated behind an explicit contractual step.
    hipaaMode: false,
    // The customer is the controller and declares this; we record it for the
    // Art. 30 register. Legitimate interests is the common default for inbound
    // service calls, but EU outbound marketing generally needs consent.
    lawfulBasis: 'legitimate_interests',
  };
}

function defaultDisclosureText(country: string): Record<string, string> {
  const base: Record<string, string> = {
    'en-US': "Hi — just so you know, you're speaking with an AI assistant.",
    'en-GB': "Hello — just so you know, you're speaking with an AI assistant.",
    'de-DE': 'Hallo — zur Information: Sie sprechen mit einem KI-Assistenten.',
    'fr-FR': "Bonjour — pour information, vous parlez avec un assistant IA.",
    'es-ES': 'Hola — le informamos de que está hablando con un asistente de IA.',
    'it-IT': "Salve — la informiamo che sta parlando con un assistente IA.",
    'nl-NL': 'Hallo — ter informatie: u spreekt met een AI-assistent.',
  };
  const preferred: Record<string, string> = {
    DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', NL: 'nl-NL', GB: 'en-GB',
  };
  const locale = preferred[country] ?? 'en-US';
  return { [locale]: base[locale]!, 'en-US': base['en-US']! };
}

// ---------------------------------------------------------------------------
// Pre-dispatch compliance chain
// ---------------------------------------------------------------------------

export interface DispatchContext {
  profile: ComplianceProfile;
  /** ISO country of the number being called. */
  calleeCountry: string;
  /** US state, when known — drives two-party consent. */
  calleeState?: string;
  /** Local time at the callee, as {dayOfWeek, hour}. */
  calleeLocalTime: { dayOfWeek: number; hour: number };
  onDncList: boolean;
  attemptsSoFar: number;
  hasConsentProof: boolean;
  isOutbound: boolean;
}

export interface DispatchDecision {
  allowed: boolean;
  reason: string;
}

const pass = { action: 'pass' } as const;
const block = (reason: string) =>
  ({ action: 'block', replacement: { allowed: false, reason }, reason }) as const;

function rule(
  key: string,
  label: string,
  fn: (ctx: DispatchContext) => string | null,
): ChainHandler<DispatchDecision, DispatchContext> {
  return {
    key,
    label,
    budgetMs: 5,
    handle: (_value, ctx) => {
      const failure = fn(ctx);
      return failure ? block(failure) : pass;
    },
  };
}

/**
 * Runs before every outbound dial. Ordered cheapest-first; short-circuits on the
 * first block, and every decision is recorded immutably (docs/03 7.5).
 */
export function buildComplianceChain(): HandlerChain<DispatchDecision, DispatchContext> {
  return new HandlerChain<DispatchDecision, DispatchContext>('compliance')
    .use(
      rule('jurisdiction', 'Permitted jurisdiction', (ctx) =>
        ctx.profile.jurisdictions.length &&
        !ctx.profile.jurisdictions.includes(ctx.calleeCountry.toUpperCase())
          ? `workspace not permitted to call ${ctx.calleeCountry}`
          : null,
      ),
    )
    .use(
      rule('dnc', 'Do-not-call registry', (ctx) =>
        ctx.isOutbound && ctx.onDncList ? 'number is on a do-not-call registry' : null,
      ),
    )
    .use(
      rule('attempts', 'Attempt cap', (ctx) =>
        ctx.attemptsSoFar >= ctx.profile.maxAttemptsPerLead
          ? `attempt cap reached (${ctx.profile.maxAttemptsPerLead})`
          : null,
      ),
    )
    .use(
      rule('calling_window', 'Calling window (callee local time)', (ctx) => {
        if (!ctx.isOutbound || !ctx.profile.callingWindows.length) return null;
        const { dayOfWeek, hour } = ctx.calleeLocalTime;
        const open = ctx.profile.callingWindows.some(
          (w) => w.dayOfWeek === dayOfWeek && hour >= w.startHour && hour < w.endHour,
        );
        return open ? null : `outside permitted calling window (local ${hour}:00, day ${dayOfWeek})`;
      }),
    )
    .use(
      rule('consent_proof', 'Prior express written consent', (ctx) =>
        ctx.isOutbound && ctx.profile.requireConsentProof && !ctx.hasConsentProof
          ? 'no proof of prior express written consent on file'
          : null,
      ),
    );
}

/** Does this call require two-party recording consent? */
export function requiresTwoPartyConsent(
  profile: ComplianceProfile,
  calleeCountry: string,
  calleeState?: string,
): boolean {
  if (profile.consentModel === 'two_party') return true;
  if (calleeCountry.toUpperCase() === 'US' && calleeState) {
    return US_STATE_TWO_PARTY.includes(calleeState.toUpperCase());
  }
  return JURISDICTIONS[calleeCountry.toUpperCase()]?.consentModel === 'two_party';
}

/** Default residency region for an org's country — inferred, then locked on use. */
export function defaultRegionFor(country: string): 'us-east' | 'eu-west' | 'eu-central' {
  const cc = country.toUpperCase();
  if (cc === 'DE' || cc === 'AT' || cc === 'CH' || cc === 'PL' || cc === 'CZ') {
    return 'eu-central'; // German-speaking customers frequently require in-country
  }
  if (isEu(cc) || cc === 'GB') return 'eu-west';
  return 'us-east';
}
