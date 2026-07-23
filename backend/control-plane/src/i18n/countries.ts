/**
 * ISO 3166-1 alpha-2 country registry: dialling, currency, timezone and locale defaults.
 *
 * This is the table that turns "we have a phone number" into "we know how to talk to this
 * person and which rules apply". It feeds three consumers:
 *   - telephony: E.164 dial codes and number-format expectations
 *   - compliance (src/services/compliance.ts): the EU/EEA flag drives GDPR handling and
 *     residency; this file is the single source of truth so the two cannot drift
 *   - i18n: which locale an unknown caller in this country should hear first
 *
 * `nativeLanguageSupported: false` is the honest admission that we route that country's
 * callers to English. docs/13 §4 sets the priority order; everything else waits.
 */

import { Registry } from '../core/patterns/registry.js';
import { LOCALES, type LocaleTag } from './locales.js';

export interface CountryDefinition {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  readonly name: string;
  /** E.164 country calling code, with leading '+'. Not unique: US and CA share +1. */
  readonly dialCode: string;
  /** Locale an unknown caller from this country hears by default. */
  readonly defaultLocale: LocaleTag;
  /** Other locales genuinely common here, in rough order of prevalence. */
  readonly otherLocales: readonly LocaleTag[];
  /** ISO 4217. */
  readonly currency: string;
  /** IANA zones, primary first. Compliance calling windows use [0] unless a lead says otherwise. */
  readonly timezones: readonly string[];
  /** EU member or EEA (IS/LI/NO). Drives GDPR posture and data residency. */
  readonly euEea: boolean;
  /** False when `defaultLocale` is an English fallback rather than the local language. */
  readonly nativeLanguageSupported: boolean;
}

export const COUNTRIES = {
  // --- EU member states ----------------------------------------------------
  AT: {
    code: 'AT', name: 'Austria', dialCode: '+43',
    defaultLocale: 'de-AT', otherLocales: ['de-DE', 'en-GB'],
    currency: 'EUR', timezones: ['Europe/Vienna'], euEea: true, nativeLanguageSupported: true,
  },
  BE: {
    code: 'BE', name: 'Belgium', dialCode: '+32',
    // Roughly 60/40 Dutch/French. Flanders is the larger market, so nl-BE leads — but a
    // Belgian agent should almost always be configured explicitly rather than defaulted.
    defaultLocale: 'nl-BE', otherLocales: ['fr-BE', 'de-DE', 'en-GB'],
    currency: 'EUR', timezones: ['Europe/Brussels'], euEea: true, nativeLanguageSupported: true,
  },
  BG: {
    code: 'BG', name: 'Bulgaria', dialCode: '+359',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'BGN', timezones: ['Europe/Sofia'], euEea: true, nativeLanguageSupported: false,
  },
  HR: {
    code: 'HR', name: 'Croatia', dialCode: '+385',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'EUR', timezones: ['Europe/Zagreb'], euEea: true, nativeLanguageSupported: false,
  },
  CY: {
    code: 'CY', name: 'Cyprus', dialCode: '+357',
    // Greek is unsupported, but English is widely used in Cypriot business.
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'EUR', timezones: ['Asia/Nicosia'], euEea: true, nativeLanguageSupported: false,
  },
  CZ: {
    code: 'CZ', name: 'Czechia', dialCode: '+420',
    defaultLocale: 'en-GB', otherLocales: ['de-DE'],
    currency: 'CZK', timezones: ['Europe/Prague'], euEea: true, nativeLanguageSupported: false,
  },
  DK: {
    code: 'DK', name: 'Denmark', dialCode: '+45',
    defaultLocale: 'da-DK', otherLocales: ['en-GB'],
    currency: 'DKK', timezones: ['Europe/Copenhagen'], euEea: true, nativeLanguageSupported: true,
  },
  EE: {
    code: 'EE', name: 'Estonia', dialCode: '+372',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'EUR', timezones: ['Europe/Tallinn'], euEea: true, nativeLanguageSupported: false,
  },
  FI: {
    code: 'FI', name: 'Finland', dialCode: '+358',
    defaultLocale: 'fi-FI', otherLocales: ['sv-SE', 'en-GB'], // Swedish is a national language
    currency: 'EUR', timezones: ['Europe/Helsinki'], euEea: true, nativeLanguageSupported: true,
  },
  FR: {
    code: 'FR', name: 'France', dialCode: '+33',
    defaultLocale: 'fr-FR', otherLocales: ['en-GB'],
    currency: 'EUR', timezones: ['Europe/Paris'], euEea: true, nativeLanguageSupported: true,
  },
  DE: {
    code: 'DE', name: 'Germany', dialCode: '+49',
    defaultLocale: 'de-DE', otherLocales: ['en-GB', 'pl-PL'],
    currency: 'EUR', timezones: ['Europe/Berlin'], euEea: true, nativeLanguageSupported: true,
  },
  GR: {
    code: 'GR', name: 'Greece', dialCode: '+30',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'EUR', timezones: ['Europe/Athens'], euEea: true, nativeLanguageSupported: false,
  },
  HU: {
    code: 'HU', name: 'Hungary', dialCode: '+36',
    defaultLocale: 'en-GB', otherLocales: ['de-DE'],
    currency: 'HUF', timezones: ['Europe/Budapest'], euEea: true, nativeLanguageSupported: false,
  },
  IE: {
    code: 'IE', name: 'Ireland', dialCode: '+353',
    defaultLocale: 'en-IE', otherLocales: ['en-GB'],
    currency: 'EUR', timezones: ['Europe/Dublin'], euEea: true, nativeLanguageSupported: true,
  },
  IT: {
    code: 'IT', name: 'Italy', dialCode: '+39',
    defaultLocale: 'it-IT', otherLocales: ['de-DE', 'en-GB'], // German is co-official in South Tyrol
    currency: 'EUR', timezones: ['Europe/Rome'], euEea: true, nativeLanguageSupported: true,
  },
  LV: {
    code: 'LV', name: 'Latvia', dialCode: '+371',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'EUR', timezones: ['Europe/Riga'], euEea: true, nativeLanguageSupported: false,
  },
  LT: {
    code: 'LT', name: 'Lithuania', dialCode: '+370',
    defaultLocale: 'en-GB', otherLocales: ['pl-PL'],
    currency: 'EUR', timezones: ['Europe/Vilnius'], euEea: true, nativeLanguageSupported: false,
  },
  LU: {
    code: 'LU', name: 'Luxembourg', dialCode: '+352',
    // Luxembourgish is unsupported; French is the working language of administration.
    defaultLocale: 'fr-FR', otherLocales: ['de-DE', 'en-GB', 'pt-PT'],
    currency: 'EUR', timezones: ['Europe/Luxembourg'], euEea: true, nativeLanguageSupported: false,
  },
  MT: {
    code: 'MT', name: 'Malta', dialCode: '+356',
    defaultLocale: 'en-GB', otherLocales: ['it-IT'], // English is an official language here
    currency: 'EUR', timezones: ['Europe/Malta'], euEea: true, nativeLanguageSupported: true,
  },
  NL: {
    code: 'NL', name: 'Netherlands', dialCode: '+31',
    defaultLocale: 'nl-NL', otherLocales: ['en-GB'],
    currency: 'EUR', timezones: ['Europe/Amsterdam'], euEea: true, nativeLanguageSupported: true,
  },
  PL: {
    code: 'PL', name: 'Poland', dialCode: '+48',
    defaultLocale: 'pl-PL', otherLocales: ['en-GB', 'de-DE'],
    currency: 'PLN', timezones: ['Europe/Warsaw'], euEea: true, nativeLanguageSupported: true,
  },
  PT: {
    code: 'PT', name: 'Portugal', dialCode: '+351',
    defaultLocale: 'pt-PT', otherLocales: ['en-GB', 'es-ES'],
    currency: 'EUR',
    timezones: ['Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores'],
    euEea: true, nativeLanguageSupported: true,
  },
  RO: {
    code: 'RO', name: 'Romania', dialCode: '+40',
    defaultLocale: 'en-GB', otherLocales: ['it-IT'],
    currency: 'RON', timezones: ['Europe/Bucharest'], euEea: true, nativeLanguageSupported: false,
  },
  SK: {
    code: 'SK', name: 'Slovakia', dialCode: '+421',
    defaultLocale: 'en-GB', otherLocales: ['de-DE'],
    currency: 'EUR', timezones: ['Europe/Bratislava'], euEea: true, nativeLanguageSupported: false,
  },
  SI: {
    code: 'SI', name: 'Slovenia', dialCode: '+386',
    defaultLocale: 'en-GB', otherLocales: ['de-DE', 'it-IT'],
    currency: 'EUR', timezones: ['Europe/Ljubljana'], euEea: true, nativeLanguageSupported: false,
  },
  ES: {
    code: 'ES', name: 'Spain', dialCode: '+34',
    defaultLocale: 'es-ES', otherLocales: ['en-GB', 'pt-PT'],
    currency: 'EUR',
    timezones: ['Europe/Madrid', 'Atlantic/Canary'], // the Canaries are one hour behind
    euEea: true, nativeLanguageSupported: true,
  },
  SE: {
    code: 'SE', name: 'Sweden', dialCode: '+46',
    defaultLocale: 'sv-SE', otherLocales: ['en-GB'],
    currency: 'SEK', timezones: ['Europe/Stockholm'], euEea: true, nativeLanguageSupported: true,
  },

  // --- EEA (non-EU) --------------------------------------------------------
  IS: {
    code: 'IS', name: 'Iceland', dialCode: '+354',
    defaultLocale: 'en-GB', otherLocales: ['da-DK'],
    currency: 'ISK', timezones: ['Atlantic/Reykjavik'], euEea: true, nativeLanguageSupported: false,
  },
  LI: {
    code: 'LI', name: 'Liechtenstein', dialCode: '+423',
    defaultLocale: 'de-CH', otherLocales: ['de-DE'],
    currency: 'CHF', timezones: ['Europe/Vaduz'], euEea: true, nativeLanguageSupported: true,
  },
  NO: {
    code: 'NO', name: 'Norway', dialCode: '+47',
    defaultLocale: 'nb-NO', otherLocales: ['en-GB'],
    currency: 'NOK', timezones: ['Europe/Oslo'], euEea: true, nativeLanguageSupported: true,
  },

  // --- Other target markets ------------------------------------------------
  CH: {
    code: 'CH', name: 'Switzerland', dialCode: '+41',
    // Not EU/EEA: Swiss data protection is the FADP, not GDPR, though the practical
    // controls we build for GDPR satisfy it. Treat residency separately.
    defaultLocale: 'de-CH', otherLocales: ['fr-FR', 'it-IT', 'en-GB'],
    currency: 'CHF', timezones: ['Europe/Zurich'], euEea: false, nativeLanguageSupported: true,
  },
  GB: {
    code: 'GB', name: 'United Kingdom', dialCode: '+44',
    defaultLocale: 'en-GB', otherLocales: [],
    currency: 'GBP', timezones: ['Europe/London'], euEea: false, nativeLanguageSupported: true,
  },
  US: {
    code: 'US', name: 'United States', dialCode: '+1',
    defaultLocale: 'en-US', otherLocales: ['es-MX'],
    currency: 'USD',
    timezones: [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
      'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    ],
    euEea: false, nativeLanguageSupported: true,
  },
  CA: {
    code: 'CA', name: 'Canada', dialCode: '+1',
    // No en-CA locale yet; en-US is acoustically and orthographically close enough that
    // shipping a separate variant would be theatre. fr-CA is a real, distinct locale.
    defaultLocale: 'en-US', otherLocales: ['fr-CA'],
    currency: 'CAD',
    timezones: [
      'America/Toronto', 'America/Winnipeg', 'America/Edmonton',
      'America/Vancouver', 'America/Halifax', 'America/St_Johns',
    ],
    euEea: false, nativeLanguageSupported: true,
  },
  AU: {
    code: 'AU', name: 'Australia', dialCode: '+61',
    defaultLocale: 'en-AU', otherLocales: [],
    currency: 'AUD',
    timezones: [
      'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane',
      'Australia/Adelaide', 'Australia/Perth', 'Australia/Darwin', 'Australia/Hobart',
    ],
    euEea: false, nativeLanguageSupported: true,
  },
  NZ: {
    code: 'NZ', name: 'New Zealand', dialCode: '+64',
    // en-AU is closer to NZ English than en-US or en-GB; a dedicated en-NZ is not worth
    // the catalog weight until there is NZ demand.
    defaultLocale: 'en-AU', otherLocales: ['en-GB'],
    currency: 'NZD', timezones: ['Pacific/Auckland', 'Pacific/Chatham'],
    euEea: false, nativeLanguageSupported: true,
  },
} as const satisfies Record<string, CountryDefinition>;

export type CountryCode = keyof typeof COUNTRIES & string;

export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

export function isCountryCode(code: string): code is CountryCode {
  return Object.prototype.hasOwnProperty.call(COUNTRIES, code.toUpperCase());
}

function lookup(code: string): CountryDefinition | undefined {
  const upper = code.toUpperCase();
  return isCountryCode(upper) ? COUNTRIES[upper] : undefined;
}

export function getCountry(code: string): CountryDefinition | undefined {
  return lookup(code);
}

/**
 * Default locale for a country. Returns en-US for unknown countries: an unrecognised
 * country code is a data problem, and answering in English beats not answering.
 */
export function countryToLocale(code: string): LocaleTag {
  return lookup(code)?.defaultLocale ?? 'en-US';
}

/** Every locale we would consider for this country, default first. */
export function localesForCountry(code: string): LocaleTag[] {
  const c = lookup(code);
  if (!c) return ['en-US'];
  return [c.defaultLocale, ...c.otherLocales];
}

export function dialCodeFor(code: string): string | undefined {
  return lookup(code)?.dialCode;
}

export function currencyFor(code: string): string | undefined {
  return lookup(code)?.currency;
}

export function timezonesFor(code: string): readonly string[] {
  return lookup(code)?.timezones ?? [];
}

/** Primary zone — what compliance uses for calling-window checks absent lead-level data. */
export function primaryTimezoneFor(code: string): string | undefined {
  return lookup(code)?.timezones[0];
}

export function isEuEea(code: string): boolean {
  return lookup(code)?.euEea ?? false;
}

/** Countries whose callers we currently answer in English because their language is unsupported. */
export function countriesWithoutNativeLanguage(): CountryDefinition[] {
  return COUNTRY_CODES.map((c) => COUNTRIES[c]).filter((c) => !c.nativeLanguageSupported);
}

/**
 * Reverse E.164 lookup. Returns every match because dial codes are not unique
 * (+1 is US and CA); the caller disambiguates with the area code or the lead record.
 */
export function countriesForDialCode(dialCode: string): CountryDefinition[] {
  const normalised = dialCode.startsWith('+') ? dialCode : `+${dialCode}`;
  return COUNTRY_CODES.map((c) => COUNTRIES[c]).filter((c) => c.dialCode === normalised);
}

/** Best-effort country for an E.164 number: longest matching dial code wins. */
export function countryForE164(e164: string): CountryDefinition | undefined {
  if (!e164.startsWith('+')) return undefined;
  let best: CountryDefinition | undefined;
  for (const code of COUNTRY_CODES) {
    const c = COUNTRIES[code];
    if (e164.startsWith(c.dialCode) && (!best || c.dialCode.length > best.dialCode.length)) {
      best = c;
    }
  }
  return best;
}

export const countryRegistry = new Registry<CountryDefinition>('countries');
for (const code of COUNTRY_CODES) {
  const def = COUNTRIES[code];
  countryRegistry.register(code, def, {
    label: `${def.name} (${def.dialCode})`,
    // EU/EEA first in dropdowns — that is where the compliance-led motion is (docs/13 §7).
    priority: def.euEea ? 20 : 10,
    metadata: {
      currency: def.currency,
      euEea: def.euEea,
      defaultLocale: def.defaultLocale,
      localeTier: LOCALES[def.defaultLocale].tier,
      nativeLanguageSupported: def.nativeLanguageSupported,
    },
  });
}
