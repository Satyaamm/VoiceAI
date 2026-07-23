/**
 * Supported-locale registry.
 *
 * docs/13 §4 makes language the wedge: the US developer platforms are English-first
 * and their DE/FR/IT/NL output is mediocre. The two things they get visibly wrong are
 * (a) formal/informal register and (b) number/date verbalisation. Both are data
 * problems, so both live here rather than being hardcoded at the TTS call site.
 *
 * The `tier` field is deliberately pessimistic. It is the MINIMUM of our TTS and ASR
 * confidence for that locale, and it is load-bearing at the type level: a locale marked
 * `beta` is excluded from `CatalogLocale`, which means messages.ts neither requires nor
 * accepts translations for it. Downgrading a locale to beta is therefore a safe,
 * one-line way to stop shipping strings we are not confident in — honesty about
 * coverage beats fake breadth, and the Localizer will log every fallback it makes.
 */

import { Registry } from '../core/patterns/registry.js';

/** Formal vs informal second person. Only meaningful for T-V languages. */
export type Register = 'formal' | 'informal';

/**
 * Our confidence in end-to-end voice quality for this locale.
 * - `native` — TTS prosody and 8 kHz ASR are good enough to sell as a differentiator.
 * - `good`   — deployable; a native speaker would call it correct but not remarkable.
 * - `beta`   — known gap. Not in the message catalog; falls back with a logged warning.
 */
export type QualityTier = 'native' | 'good' | 'beta';

export interface TvPronouns {
  /** Subject pronoun, e.g. "Sie" / "du". */
  readonly subject: string;
  /** Object/dative form, e.g. "Ihnen" / "dir". */
  readonly object: string;
  /** Possessive, e.g. "Ihr" / "dein". */
  readonly possessive: string;
}

export interface TvDistinction {
  readonly formal: TvPronouns;
  readonly informal: TvPronouns;
  /**
   * Whether informal address is the everyday norm for consumer business in this
   * locale. Purely a dashboard hint — it does NOT change the default register.
   * See DEFAULT_REGISTER below for why the default is always formal.
   */
  readonly informalIsCommon: boolean;
}

export interface NumberFormat {
  /** Decimal separator as spoken/written, e.g. "," in de-DE. */
  readonly decimal: string;
  /** Thousands group separator. Empty string means "no grouping". */
  readonly group: string;
}

export interface LocaleDefinition {
  readonly tag: string;
  /** ISO 639-1 base language — the fallback rung between exact tag and en-US. */
  readonly language: string;
  /** ISO 3166-1 alpha-2 region of this variant. */
  readonly region: string;
  readonly englishName: string;
  /** Endonym. Shown in the dashboard so the customer sees their own language. */
  readonly nativeName: string;
  readonly direction: 'ltr' | 'rtl';
  readonly ttsQuality: QualityTier;
  readonly asrQuality: QualityTier;
  /** Conservative min(tts, asr). Drives catalog membership at the type level. */
  readonly tier: QualityTier;
  /** null for languages with no T-V distinction (English, the Nordics). */
  readonly tv: TvDistinction | null;
  /**
   * Multiplier on the agent's base TTS rate. Languages differ in syllable rate and
   * in how much acoustic room a listener needs on a 8 kHz narrowband line: German
   * and Finnish compounds and Polish consonant clusters lose intelligibility when
   * rushed, while Spanish and Italian are natively fast and sound sluggish at 1.0.
   */
  readonly speakingRateAdjust: number;
  readonly numberFormat: NumberFormat;
  /** Why this tier — kept next to the claim so it can be challenged. */
  readonly tierNote: string;
}

/**
 * We default to FORMAL in every T-V locale regardless of local convention.
 *
 * The cost is asymmetric (docs/13 §4): addressing a German or French stranger with
 * du/tu reads as either contemptuous or naive and can end a B2C relationship on the
 * first turn, whereas Sie/vous with someone who would have preferred informal reads
 * as merely a little stiff. Workspaces override this per agent; the default never does.
 */
export const DEFAULT_REGISTER: Register = 'formal';

export const LOCALES = {
  // --- English -------------------------------------------------------------
  'en-US': {
    tag: 'en-US',
    language: 'en',
    region: 'US',
    englishName: 'English (United States)',
    nativeName: 'English (United States)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: null,
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: '.', group: ',' },
    tierNote: 'Reference locale. Every other locale is measured against this one.',
  },
  'en-GB': {
    tag: 'en-GB',
    language: 'en',
    region: 'GB',
    englishName: 'English (United Kingdom)',
    nativeName: 'English (United Kingdom)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: null,
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: '.', group: ',' },
    tierNote: 'Strong vendor coverage; regional accents (Glaswegian, Geordie) still weakest.',
  },
  'en-AU': {
    tag: 'en-AU',
    language: 'en',
    region: 'AU',
    englishName: 'English (Australia)',
    nativeName: 'English (Australia)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: null,
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: '.', group: ',' },
    tierNote: 'Good voices, but vowel-shift errors on ASR for names and postcodes.',
  },
  'en-IE': {
    tag: 'en-IE',
    language: 'en',
    region: 'IE',
    englishName: 'English (Ireland)',
    nativeName: 'English (Ireland)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: null,
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: '.', group: ',' },
    tierNote: 'Few true Hiberno-English voices; ASR degrades on rural accents.',
  },

  // --- German --------------------------------------------------------------
  'de-DE': {
    tag: 'de-DE',
    language: 'de',
    region: 'DE',
    englishName: 'German (Germany)',
    nativeName: 'Deutsch (Deutschland)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      formal: { subject: 'Sie', object: 'Ihnen', possessive: 'Ihr' },
      informal: { subject: 'du', object: 'dir', possessive: 'dein' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 0.97,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'The flagship non-English locale — the Frankfurt pitch in docs/13 §4 rests on it.',
  },
  'de-AT': {
    tag: 'de-AT',
    language: 'de',
    region: 'AT',
    englishName: 'German (Austria)',
    nativeName: 'Deutsch (Österreich)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'Sie', object: 'Ihnen', possessive: 'Ihr' },
      informal: { subject: 'du', object: 'dir', possessive: 'dein' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 0.97,
    numberFormat: { decimal: ',', group: '.' },
    tierNote:
      'Standard Austrian German is well covered; Viennese and Tyrolean ASR is noticeably worse.',
  },
  'de-CH': {
    tag: 'de-CH',
    language: 'de',
    region: 'CH',
    englishName: 'German (Switzerland)',
    nativeName: 'Deutsch (Schweiz)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'beta',
    tier: 'beta',
    tv: {
      formal: { subject: 'Sie', object: 'Ihnen', possessive: 'Ihr' },
      informal: { subject: 'du', object: 'dir', possessive: 'dein' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 0.97,
    numberFormat: { decimal: '.', group: "'" },
    tierNote:
      'BETA: docs/13 §4 names Swiss German as a hard accent and it is. Swiss callers speak ' +
      'dialect, not Hochdeutsch, and general de ASR mis-transcribes it badly. Written output ' +
      'falls back to de-DE, which is safe for TTS (ß vs. ss is inaudible) but the ASR side is ' +
      'not sellable yet.',
  },

  // --- French --------------------------------------------------------------
  'fr-FR': {
    tag: 'fr-FR',
    language: 'fr',
    region: 'FR',
    englishName: 'French (France)',
    nativeName: 'Français (France)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      formal: { subject: 'vous', object: 'vous', possessive: 'votre' },
      informal: { subject: 'tu', object: 'te', possessive: 'ton' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: ',', group: ' ' }, // narrow no-break space, per Imprimerie nationale
    tierNote: 'Strong voices; liaison handling is the normalisation layer’s problem, not TTS’s.',
  },
  'fr-BE': {
    tag: 'fr-BE',
    language: 'fr',
    region: 'BE',
    englishName: 'French (Belgium)',
    nativeName: 'Français (Belgique)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'vous', object: 'vous', possessive: 'votre' },
      informal: { subject: 'tu', object: 'te', possessive: 'ton' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote:
      'No dedicated Belgian voices; we use fr-FR TTS. Matters for numbers: septante/nonante ' +
      'are handled in normalisation, not here.',
  },
  'fr-CA': {
    tag: 'fr-CA',
    language: 'fr',
    region: 'CA',
    englishName: 'French (Canada)',
    nativeName: 'Français (Canada)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'vous', object: 'vous', possessive: 'votre' },
      informal: { subject: 'tu', object: 'te', possessive: 'ton' },
      // Québec business French tutoies far earlier than France does.
      informalIsCommon: true,
    },
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote: 'Québécois voices exist and are decent; joual-heavy speech still trips ASR.',
  },

  // --- Spanish -------------------------------------------------------------
  'es-ES': {
    tag: 'es-ES',
    language: 'es',
    region: 'ES',
    englishName: 'Spanish (Spain)',
    nativeName: 'Español (España)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      formal: { subject: 'usted', object: 'le', possessive: 'su' },
      informal: { subject: 'tú', object: 'te', possessive: 'tu' },
      // Spain tutea in most consumer contexts; banking and utilities still use usted.
      informalIsCommon: true,
    },
    speakingRateAdjust: 1.03,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'Castilian is well covered; Andalusian ASR (docs/13 §4) is the weak spot.',
  },
  'es-MX': {
    tag: 'es-MX',
    language: 'es',
    region: 'MX',
    englishName: 'Spanish (Mexico)',
    nativeName: 'Español (México)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      formal: { subject: 'usted', object: 'le', possessive: 'su' },
      informal: { subject: 'tú', object: 'te', possessive: 'tu' },
      // Mexico keeps usted with strangers far longer than Spain does.
      informalIsCommon: false,
    },
    speakingRateAdjust: 1.02,
    numberFormat: { decimal: '.', group: ',' }, // Mexico follows US conventions, unlike Spain
    tierNote: 'Best-covered LatAm variant; also the practical default for US Spanish traffic.',
  },

  // --- Italian -------------------------------------------------------------
  'it-IT': {
    tag: 'it-IT',
    language: 'it',
    region: 'IT',
    englishName: 'Italian (Italy)',
    nativeName: 'Italiano (Italia)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      formal: { subject: 'Lei', object: 'Le', possessive: 'Suo' },
      informal: { subject: 'tu', object: 'ti', possessive: 'tuo' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 1.02,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'Good voices; southern regional speech is the ASR gap.',
  },

  // --- Dutch ---------------------------------------------------------------
  'nl-NL': {
    tag: 'nl-NL',
    language: 'nl',
    region: 'NL',
    englishName: 'Dutch (Netherlands)',
    nativeName: 'Nederlands (Nederland)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'u', object: 'u', possessive: 'uw' },
      informal: { subject: 'je', object: 'je', possessive: 'jouw' },
      // The Netherlands is the most informal market on this list.
      informalIsCommon: true,
    },
    speakingRateAdjust: 0.99,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'Voices are strong; ASR on Dutch numerals and spelled names lags docs/03 §B targets.',
  },
  'nl-BE': {
    tag: 'nl-BE',
    language: 'nl',
    region: 'BE',
    englishName: 'Dutch (Belgium / Flemish)',
    nativeName: 'Nederlands (België)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'u', object: 'u', possessive: 'uw' },
      informal: { subject: 'je', object: 'je', possessive: 'jouw' },
      // Flanders uses "u" much more readily than the Netherlands, including with peers.
      informalIsCommon: false,
    },
    speakingRateAdjust: 0.99,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'Flemish voices exist but are fewer; tussentaal in caller speech hurts ASR.',
  },

  // --- Portuguese ----------------------------------------------------------
  'pt-PT': {
    tag: 'pt-PT',
    language: 'pt',
    region: 'PT',
    englishName: 'Portuguese (Portugal)',
    nativeName: 'Português (Portugal)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      formal: { subject: 'você / o senhor', object: 'lhe', possessive: 'seu' },
      informal: { subject: 'tu', object: 'te', possessive: 'teu' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote:
      'European Portuguese is materially worse served than pt-BR — heavy vowel reduction ' +
      'hurts ASR and most vendor "pt" voices are Brazilian.',
  },
  'pt-BR': {
    tag: 'pt-BR',
    language: 'pt',
    region: 'BR',
    englishName: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    direction: 'ltr',
    ttsQuality: 'native',
    asrQuality: 'native',
    tier: 'native',
    tv: {
      // In Brazil "você" is the neutral default and the true formal is "o senhor / a senhora",
      // which is gendered. Our formal strings avoid the pronoun where possible for that reason.
      formal: { subject: 'o senhor / a senhora', object: 'lhe', possessive: 'seu' },
      informal: { subject: 'você', object: 'te', possessive: 'seu' },
      informalIsCommon: true,
    },
    speakingRateAdjust: 1.0,
    numberFormat: { decimal: ',', group: '.' },
    tierNote: 'Excellent vendor coverage. Not an EU market, but the best pt reference we have.',
  },

  // --- Polish --------------------------------------------------------------
  'pl-PL': {
    tag: 'pl-PL',
    language: 'pl',
    region: 'PL',
    englishName: 'Polish (Poland)',
    nativeName: 'Polski (Polska)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'good',
    tier: 'good',
    tv: {
      // Polish honorifics are gendered (Pan/Pani) and inflect the verb. Where the caller's
      // gender is unknown our formal strings use impersonal constructions instead.
      formal: { subject: 'Pan / Pani', object: 'Panu / Pani', possessive: 'Pana / Pani' },
      informal: { subject: 'ty', object: 'ci', possessive: 'twój' },
      informalIsCommon: false,
    },
    speakingRateAdjust: 0.96,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote: 'Solid voices; consonant clusters need the slower rate to stay intelligible at 8 kHz.',
  },

  // --- Nordics — the acknowledged gap (docs/13 §4, "Nordic for the enterprise tail") ---
  'sv-SE': {
    tag: 'sv-SE',
    language: 'sv',
    region: 'SE',
    englishName: 'Swedish (Sweden)',
    nativeName: 'Svenska (Sverige)',
    direction: 'ltr',
    ttsQuality: 'good',
    asrQuality: 'beta',
    tier: 'beta',
    tv: null, // the du-reformen of the 1960s effectively removed the T-V distinction
    speakingRateAdjust: 0.98,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote:
      'BETA: pitch-accent errors make vendor TTS sound foreign to Swedes, and telephony ASR ' +
      'is untested against our docs/03 §B slot-accuracy bar.',
  },
  'da-DK': {
    tag: 'da-DK',
    language: 'da',
    region: 'DK',
    englishName: 'Danish (Denmark)',
    nativeName: 'Dansk (Danmark)',
    direction: 'ltr',
    ttsQuality: 'beta',
    asrQuality: 'beta',
    tier: 'beta',
    tv: null, // "De" survives only in ceremonial use; treating it as live would sound archaic
    speakingRateAdjust: 0.97,
    numberFormat: { decimal: ',', group: '.' },
    tierNote:
      'BETA: the weakest locale here. Danish stød and heavy vowel reduction defeat both ' +
      'general ASR and vendor TTS, and the vigesimal number system (halvfems = 90) makes ' +
      'readback error-prone.',
  },
  'nb-NO': {
    tag: 'nb-NO',
    language: 'nb',
    region: 'NO',
    englishName: 'Norwegian Bokmål (Norway)',
    nativeName: 'Norsk bokmål (Norge)',
    direction: 'ltr',
    ttsQuality: 'beta',
    asrQuality: 'beta',
    tier: 'beta',
    tv: null,
    speakingRateAdjust: 0.98,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote:
      'BETA: Norway has no single spoken standard — callers use their local dialect ' +
      'unapologetically, which is a much harder ASR problem than the written Bokmål norm suggests.',
  },
  'fi-FI': {
    tag: 'fi-FI',
    language: 'fi',
    region: 'FI',
    englishName: 'Finnish (Finland)',
    nativeName: 'Suomi (Suomi)',
    direction: 'ltr',
    ttsQuality: 'beta',
    asrQuality: 'beta',
    tier: 'beta',
    tv: null, // teitittely exists but is now rare enough that using it reads as distancing
    speakingRateAdjust: 0.95,
    numberFormat: { decimal: ',', group: ' ' },
    tierNote:
      'BETA: fifteen cases plus consonant gradation mean any slot value has to be inflected ' +
      'to be grammatical. Until normalisation handles that, generated Finnish reads as broken.',
  },
} as const satisfies Record<string, LocaleDefinition>;

export type LocaleMap = typeof LOCALES;
export type LocaleTag = keyof LocaleMap & string;

/**
 * Locales we are willing to ship strings for. Derived from `tier`, so demoting a
 * locale to `beta` above deletes its obligations in messages.ts at compile time.
 */
export type CatalogLocale = {
  [K in LocaleTag]: LocaleMap[K]['tier'] extends 'beta' ? never : K;
}[LocaleTag];

/** Locales with a T-V distinction. Also derived — the data decides, not a hand-kept list. */
export type TvLocale = {
  [K in LocaleTag]: LocaleMap[K]['tv'] extends null ? never : K;
}[LocaleTag];

export const LOCALE_TAGS = Object.keys(LOCALES) as LocaleTag[];

export const CATALOG_LOCALES = LOCALE_TAGS.filter(
  (t) => LOCALES[t].tier !== 'beta',
) as CatalogLocale[];

export const BETA_LOCALES = LOCALE_TAGS.filter((t) => LOCALES[t].tier === 'beta');

export function isLocaleTag(tag: string): tag is LocaleTag {
  return Object.prototype.hasOwnProperty.call(LOCALES, tag);
}

export function isCatalogLocale(tag: string): tag is CatalogLocale {
  return isLocaleTag(tag) && LOCALES[tag].tier !== 'beta';
}

export function getLocale(tag: LocaleTag): LocaleDefinition {
  return LOCALES[tag];
}

export function hasTvDistinction(tag: LocaleTag): boolean {
  return LOCALES[tag].tv !== null;
}

/**
 * The variant we treat as canonical for a bare language code. Used as the middle rung
 * of the Localizer's fallback ladder (exact tag -> base language -> en-US), and chosen
 * by market weight rather than speaker count: de-DE over de-AT, pt-PT over pt-BR
 * because our Portuguese demand is European even though pt-BR is the better locale.
 */
export const BASE_LANGUAGE_DEFAULT: Readonly<Record<string, LocaleTag>> = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  nl: 'nl-NL',
  pt: 'pt-PT',
  pl: 'pl-PL',
  sv: 'sv-SE',
  da: 'da-DK',
  nb: 'nb-NO',
  no: 'nb-NO', // "no" is the macrolanguage tag; callers and CRMs emit it constantly
  fi: 'fi-FI',
};

/** Registry so the dashboard can enumerate locales the same way it enumerates providers. */
export const localeRegistry = new Registry<LocaleDefinition>('locales');
for (const tag of LOCALE_TAGS) {
  const def = LOCALES[tag];
  localeRegistry.register(tag, def, {
    label: `${def.englishName} — ${def.nativeName}`,
    // Sorts native locales to the top of dropdowns; beta sinks to the bottom.
    priority: def.tier === 'native' ? 30 : def.tier === 'good' ? 20 : 10,
    metadata: {
      tier: def.tier,
      ttsQuality: def.ttsQuality,
      asrQuality: def.asrQuality,
      hasTv: def.tv !== null,
      language: def.language,
      region: def.region,
    },
  });
}

/** Format a number using the locale's own separators. */
export function formatNumber(tag: LocaleTag, value: number, fractionDigits = 2): string {
  const { decimal, group } = LOCALES[tag].numberFormat;
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const dot = fixed.indexOf('.');
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot + 1);
  const grouped = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, group) : whole;
  return `${negative ? '-' : ''}${grouped}${frac ? decimal + frac : ''}`;
}
