/**
 * i18n barrel + the Localizer the orchestrator talks to.
 *
 * The Localizer is intentionally tiny and synchronous: it is called on the hot path
 * (a filler has to be chosen inside the 500ms dead-air budget, docs/03 1.8) so it does
 * no I/O, no formatting library, and no allocation beyond a string.
 *
 * FALLBACK IS LOUD. Every resolution that is not an exact catalog hit emits a logged
 * event. A German customer silently getting English is exactly the failure docs/13 §4
 * says loses the deal, so the gap has to be visible in logs and dashboards rather than
 * discovered by the customer.
 */

import {
  BASE_LANGUAGE_DEFAULT,
  DEFAULT_REGISTER,
  LOCALES,
  formatNumber,
  isCatalogLocale,
  isLocaleTag,
  type CatalogLocale,
  type LocaleDefinition,
  type LocaleTag,
  type Register,
} from './locales.js';
import { COUNTRIES, countryToLocale, isCountryCode } from './countries.js';
import {
  CONFIRM_PLACEHOLDER,
  MESSAGES,
  pickRegister,
  type ErrorKind,
  type RepromptLadder,
  type RepromptLevel,
} from './messages.js';

export * from './locales.js';
export * from './countries.js';
export * from './messages.js';

export type FallbackReason =
  /** Tag is not in our registry at all — bad data upstream. */
  | 'unknown_locale'
  /** Known locale, but marked beta: we have no strings we are willing to ship. */
  | 'beta_locale'
  /** Region variant unknown, resolved via the base language (de-LU -> de-DE). */
  | 'region_variant'
  /** The language itself is unsupported — this caller hears English. */
  | 'unsupported_language';

export interface FallbackEvent {
  readonly requested: string;
  readonly resolved: CatalogLocale;
  readonly reason: FallbackReason;
  readonly message: string;
}

export type I18nLogger = (event: FallbackEvent) => void;

/**
 * Deduped by (requested, reason). A locale gap is a static configuration fact, and
 * logging it once per call would produce thousands of identical lines a day and get
 * filtered out — which defeats the point of logging it at all.
 */
const loggedFallbacks = new Set<string>();

const defaultLogger: I18nLogger = (event) => {
  const key = `${event.requested}|${event.reason}`;
  if (loggedFallbacks.has(key)) return;
  loggedFallbacks.add(key);
  console.warn(`[i18n] ${event.message}`);
};

/** Test hook — lets a suite assert on first-occurrence logging repeatedly. */
export function resetFallbackLog(): void {
  loggedFallbacks.clear();
}

/** "de_de", "DE-de", " de-DE " all mean de-DE. CRM exports are not disciplined about this. */
export function normalizeTag(tag: string): string {
  const cleaned = tag.trim().replace('_', '-');
  const [lang, region] = cleaned.split('-');
  if (!lang) return '';
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

export interface Resolution {
  readonly locale: CatalogLocale;
  /** Present iff this was not an exact catalog hit. */
  readonly fallback?: FallbackEvent;
}

/**
 * Exact tag -> base language default -> en-US.
 *
 * A beta locale never resolves to itself: locales.ts marks it beta precisely because we
 * are not confident in its strings, so it drops to the next rung rather than shipping
 * something a native speaker would wince at.
 */
export function resolveLocale(requested: string): Resolution {
  const tag = normalizeTag(requested);

  if (isCatalogLocale(tag)) return { locale: tag };

  const language = tag.split('-')[0] ?? '';
  const baseDefault = BASE_LANGUAGE_DEFAULT[language];

  // Known tag, but beta — e.g. de-CH, sv-SE.
  if (isLocaleTag(tag)) {
    if (baseDefault && baseDefault !== tag && isCatalogLocale(baseDefault)) {
      return {
        locale: baseDefault,
        fallback: {
          requested,
          resolved: baseDefault,
          reason: 'beta_locale',
          message:
            `${tag} is marked beta in locales.ts (${LOCALES[tag].ttsQuality} TTS / ` +
            `${LOCALES[tag].asrQuality} ASR); serving ${baseDefault} instead`,
        },
      };
    }
    return {
      locale: 'en-US',
      fallback: {
        requested,
        resolved: 'en-US',
        reason: 'beta_locale',
        message: `${tag} is beta and its base language has no shippable variant; serving en-US`,
      },
    };
  }

  // Unknown region variant of a supported language — de-LU, es-AR, fr-CH.
  if (baseDefault && isCatalogLocale(baseDefault)) {
    return {
      locale: baseDefault,
      fallback: {
        requested,
        resolved: baseDefault,
        reason: 'region_variant',
        message: `no catalog entry for "${requested}"; serving ${baseDefault} via base language "${language}"`,
      },
    };
  }

  // Supported-ish language whose canonical variant is itself beta (sv, da, nb, fi).
  if (baseDefault) {
    return {
      locale: 'en-US',
      fallback: {
        requested,
        resolved: 'en-US',
        reason: 'beta_locale',
        message: `"${language}" resolves to ${baseDefault}, which is beta; serving en-US`,
      },
    };
  }

  return {
    locale: 'en-US',
    fallback: {
      requested,
      resolved: 'en-US',
      reason: language ? 'unsupported_language' : 'unknown_locale',
      message: `"${requested}" is not a supported locale; serving en-US`,
    },
  };
}

export interface LocalizerOptions {
  /** Defaults to formal — see DEFAULT_REGISTER in locales.ts for why. */
  readonly register?: Register;
  readonly logger?: I18nLogger;
  /** Injectable for deterministic tests of filler rotation. */
  readonly random?: () => number;
}

/**
 * Per-call (or per-agent) view of the catalog. Cheap to construct; hold one per call
 * so the filler rotation state is scoped to the conversation rather than global.
 */
export class Localizer {
  readonly requested: string;
  readonly locale: CatalogLocale;
  readonly definition: LocaleDefinition;
  readonly register: Register;
  readonly fallback: FallbackEvent | undefined;

  private readonly random: () => number;
  /** Index of the last filler served, so we never repeat one back-to-back. */
  private lastFillerIndex = -1;

  constructor(requestedLocale: string, opts: LocalizerOptions = {}) {
    const { locale, fallback } = resolveLocale(requestedLocale);
    this.requested = requestedLocale;
    this.locale = locale;
    this.definition = LOCALES[locale];
    this.fallback = fallback;
    this.random = opts.random ?? Math.random;

    // A register preference for a locale with no T-V distinction is harmless but
    // meaningless; we keep it so `withRegister` round-trips cleanly.
    this.register = opts.register ?? DEFAULT_REGISTER;

    if (fallback) (opts.logger ?? defaultLogger)(fallback);
  }

  /** True when the caller is not hearing the locale that was asked for. */
  get isFallback(): boolean {
    return this.fallback !== undefined;
  }

  get hasTvDistinction(): boolean {
    return this.definition.tv !== null;
  }

  /** Same locale, different register. Used when a flow escalates to a formal sub-dialog. */
  withRegister(register: Register): Localizer {
    return new Localizer(this.locale, { register, random: this.random });
  }

  /**
   * EU AI Act disclosure (docs/14). ALWAYS formal, whatever the agent's register:
   * this is a legal statement and formality is never the wrong choice for one.
   */
  disclosure(): string {
    return pickRegister(MESSAGES.aiDisclosure[this.locale], 'formal');
  }

  /**
   * A continuer for tool-call dead air (docs/03 1.8).
   * Never returns the same string twice in a row — repetition is the single clearest
   * tell that the caller is talking to a machine.
   */
  filler(): string {
    const pool = pickRegister<readonly string[]>(MESSAGES.fillers[this.locale], this.register);
    if (pool.length === 0) return '';
    if (pool.length === 1) return pool[0] ?? '';

    let index = Math.floor(this.random() * pool.length) % pool.length;
    if (index === this.lastFillerIndex) index = (index + 1) % pool.length;
    this.lastFillerIndex = index;
    return pool[index] ?? '';
  }

  /** Escalating no-input ladder, 1-3. Level 3 is the graceful exit (docs/03 2.11). */
  reprompt(level: RepromptLevel): string {
    const ladder = pickRegister<RepromptLadder>(
      MESSAGES.reprompts[this.locale],
      this.register,
    );
    // Clamped rather than throwing: an off-by-one in the FSM must not drop the call.
    const index = Math.min(Math.max(level, 1), 3) - 1;
    return ladder[index] ?? ladder[2];
  }

  handoff(): string {
    return pickRegister<string>(MESSAGES.handoff[this.locale], this.register);
  }

  /**
   * Confirm-back for a low-confidence slot segment (docs/03 §B 2.5).
   * `value` must already be verbalised by the normalisation layer — this function does
   * not know how to read "AB72" aloud in Polish, and should not try.
   */
  confirm(value: string): string {
    const template = pickRegister<string>(MESSAGES.confirmations[this.locale], this.register);
    return template.split(CONFIRM_PLACEHOLDER).join(value);
  }

  error(kind: ErrorKind): string {
    const set = pickRegister(MESSAGES.errors[this.locale], this.register);
    return set[kind];
  }

  /** Locale-correct number rendering, for readback of amounts and quantities. */
  number(value: number, fractionDigits = 2): string {
    return formatNumber(this.locale, value, fractionDigits);
  }
}

/** Build a Localizer from an ISO country code rather than a locale tag. */
export function localizerForCountry(country: string, opts: LocalizerOptions = {}): Localizer {
  return new Localizer(countryToLocale(country), opts);
}

/**
 * Drop-in replacement for the hardcoded `defaultDisclosureText` stub in
 * src/services/compliance.ts. Same shape (Record<localeTag, string>) so that file can
 * adopt it by deleting its private helper and importing this one — no schema change.
 *
 * Returns the country's own locales plus en-US, because an EU agent frequently has to
 * handle an English-speaking caller and the disclosure must exist in whatever language
 * the call actually ends up in.
 */
export function disclosureTextFor(country: string): Record<string, string> {
  const code = country.toUpperCase();
  const tags: LocaleTag[] = isCountryCode(code)
    ? [COUNTRIES[code].defaultLocale, ...COUNTRIES[code].otherLocales]
    : [];

  const out: Record<string, string> = {};
  for (const tag of [...tags, 'en-US' as const]) {
    // Beta locales resolve to their fallback, so the map never contains a string we
    // are not confident in — but it is keyed by the RESOLVED tag, not the requested
    // one, so nobody can mistake a fallback for real coverage.
    const { locale } = resolveLocale(tag);
    out[locale] = pickRegister(MESSAGES.aiDisclosure[locale], 'formal');
  }
  return out;
}

/**
 * Coverage snapshot for the dashboard and for release notes: which locales are real,
 * which are English underneath. Keeping this honest is a product decision (docs/13 §4).
 */
export function coverageReport(): Array<{
  locale: LocaleTag;
  tier: string;
  hasCatalog: boolean;
  servedBy: CatalogLocale;
}> {
  return (Object.keys(LOCALES) as LocaleTag[]).map((tag) => ({
    locale: tag,
    tier: LOCALES[tag].tier,
    hasCatalog: isCatalogLocale(tag),
    servedBy: resolveLocale(tag).locale,
  }));
}
