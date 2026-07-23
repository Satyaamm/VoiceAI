/**
 * Text normalization — types.
 *
 * docs/03 §D. Sits between LLM output and TTS, on the hot path (docs/02): the
 * orchestrator hands TTS whole CLAUSES, so everything here must work on a clause
 * at a time and finish in well under 5ms.
 *
 * Three stages, in order:
 *   1. sanitize  — language independent. Strip markdown/JSON/emoji/stage directions.
 *   2. verbalize — locale aware. Numbers, currency, dates, times, phone, URL, email,
 *                  acronyms, units, ranges, digit grouping.
 *   3. lexicon   — per-tenant pronunciation overrides (brand names, drugs, places).
 *
 * Everything reports what it changed so the trace viewer can show a diff.
 */

/** Languages with a hand-written verbalizer. Anything else falls back to `en`. */
export type LanguageCode = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl';

export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = ['en', 'de', 'fr', 'es', 'it', 'nl'];

/**
 * du/Sie, tu/vous, tú/usted. Carried through the pipeline because a tenant lexicon
 * entry or an acronym policy may legitimately differ by register, and because the
 * TTS prompt downstream wants it (docs/13 §4).
 */
export type Register = 'formal' | 'informal';

/**
 * How an ambiguous all-numeric date is read. `10/03/2026` is October 3rd in the US
 * and 10 March everywhere in Europe — booking the wrong one is a real, expensive bug,
 * so the rule is explicit rather than inferred from the digits.
 */
export type DateOrder = 'MDY' | 'DMY' | 'YMD';

/**
 * How pauses are rendered for readback grouping (docs/03 3.7).
 * - `punctuation`: a comma. Universally respected by every TTS engine.
 * - `ssml`: `<break time="…"/>`. Only for providers that accept SSML.
 */
export type PauseStyle = 'punctuation' | 'ssml';

/**
 * Acronym policy (docs/03 3.3).
 * - `spell`: read letter by letter — "S Q L", "I B M".
 * - `word`:  read as a word — "NASA", "NATO".
 * - a string: read exactly this instead (a respelling, e.g. `SQL` -> `sequel`).
 */
export type AcronymPolicy = 'spell' | 'word' | (string & {});

/** French-speaking regions disagree about 70/80/90. See verbalize/fr.ts. */
export type FrenchNumberSystem = 'standard' | 'belgian' | 'swiss';

export interface NormalizationContext {
  /** BCP-47 as configured on the agent, e.g. `de-DE`, `en-US`, `fr-BE`. */
  readonly locale: string;
  /** Resolved from `locale`, falling back to `en`. */
  readonly language: LanguageCode;
  /** Uppercase region subtag, if present: `DE`, `US`, `BE`. */
  readonly region: string | undefined;
  /** ISO-4217 default for bare amounts (`1.234,50` with no symbol). */
  readonly currency: string;
  readonly register: Register;
  /** Explicit — never guessed. See {@link DateOrder}. */
  readonly dateOrder: DateOrder;
  readonly pauseStyle: PauseStyle;
  /** Whether the downstream TTS provider accepts SSML (gates `<phoneme>`/`<break>`). */
  readonly ssml: boolean;
  /** Group size for digit-string readback: 3 by default, 4 reads better for card-like IDs. */
  readonly digitGroupSize: number;
  /** Per-tenant acronym overrides, keyed by the uppercase token. */
  readonly acronyms: Readonly<Record<string, AcronymPolicy>>;
  /** Belgian/Swiss septante–huitante–nonante. Ignored outside French. */
  readonly frenchNumbers: FrenchNumberSystem;
  /**
   * en-GB says "one thousand two hundred AND thirty-four"; en-US does not.
   * Derived from region, overridable.
   */
  readonly britishAnd: boolean;
}

/** Everything is optional at the call site; {@link resolveContext} fills the rest. */
export type NormalizationContextInput = Partial<Omit<NormalizationContext, 'language' | 'region'>> & {
  locale?: string;
};

export type TransformStage = 'sanitize' | 'verbalize' | 'lexicon';

export type TransformKind =
  // sanitize
  | 'markdown'
  | 'code'
  | 'html'
  | 'json-artifact'
  | 'emoji'
  | 'stage-direction'
  | 'whitespace'
  // verbalize
  | 'number'
  | 'ordinal'
  | 'currency'
  | 'date'
  | 'time'
  | 'phone'
  | 'url'
  | 'email'
  | 'acronym'
  | 'unit'
  | 'percent'
  | 'range'
  | 'digit-group'
  // lexicon
  | 'phoneme'
  | 'respell';

/** One recorded edit, for the trace viewer. */
export interface Transformation {
  readonly stage: TransformStage;
  readonly kind: TransformKind;
  /** The text that was matched. */
  readonly source: string;
  /** What replaced it. Empty string means "deleted". */
  readonly output: string;
}

export type TransformSink = (t: Transformation) => void;

export interface NormalizationResult {
  /** TTS-ready text. */
  readonly text: string;
  /** The input, verbatim. */
  readonly input: string;
  readonly language: LanguageCode;
  readonly transformations: readonly Transformation[];
  /** Wall-clock cost of this call. Budget is 5ms per clause (docs/02). */
  readonly durationMs: number;
}

/** Anything that rewrites text and reports what it did. */
export interface Normalizer {
  readonly name: string;
  run(text: string, ctx: NormalizationContext, sink: TransformSink): string;
}

/** A per-language verbalizer. Grammar lives in the implementation, not in a table. */
export interface Verbalizer extends Normalizer {
  readonly language: LanguageCode;
  /** 1234 -> "eintausendzweihundertvierunddreißig". */
  cardinal(n: number, ctx: NormalizationContext): string;
  /** 3 -> "dritte" / "third" / "troisième". */
  ordinal(n: number, ctx: NormalizationContext): string;
}

// ---------------------------------------------------------------------------
// Lexicon (docs/03 §D stage 3)
// ---------------------------------------------------------------------------

export type PhonemeAlphabet = 'ipa' | 'x-sampa';

export interface LexiconEntry {
  /** The written form as it appears after verbalization. Matched case-insensitively. */
  readonly term: string;
  /** Phonetic transcription. Used only when the provider accepts SSML. */
  readonly phoneme?: string;
  readonly alphabet?: PhonemeAlphabet;
  /** Plain-text respelling, e.g. `Acme` -> `Ack me`. The non-SSML fallback. */
  readonly respell?: string;
  /** Restrict to one language; omit to apply in every language. */
  readonly language?: LanguageCode;
  /** Require an exact case match (for things like `IT` vs `it`). */
  readonly caseSensitive?: boolean;
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

const LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

/** MDY is a US/Philippine convention. Everything else in our markets is DMY. */
const MDY_REGIONS = new Set(['US', 'PH']);

const REGION_CURRENCY: Readonly<Record<string, string>> = {
  US: 'USD',
  GB: 'GBP',
  CH: 'CHF',
  CA: 'CAD',
  AU: 'AUD',
  DE: 'EUR',
  AT: 'EUR',
  FR: 'EUR',
  BE: 'EUR',
  NL: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  IE: 'EUR',
  PT: 'EUR',
};

const LANGUAGE_DEFAULT_CURRENCY: Readonly<Record<LanguageCode, string>> = {
  en: 'USD',
  de: 'EUR',
  fr: 'EUR',
  es: 'EUR',
  it: 'EUR',
  nl: 'EUR',
};

export function parseLocale(locale: string): { language: LanguageCode; region: string | undefined } {
  const parts = locale.replace('_', '-').split('-');
  const raw = (parts[0] ?? '').toLowerCase();
  const language: LanguageCode = LANGUAGE_SET.has(raw) ? (raw as LanguageCode) : 'en';
  let region: string | undefined;
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i];
    if (p !== undefined && /^[A-Za-z]{2}$/.test(p)) {
      region = p.toUpperCase();
      break;
    }
  }
  return { language, region };
}

/** Fill a full context from whatever the caller supplied. Cheap; safe to call per clause. */
export function resolveContext(input: NormalizationContextInput = {}): NormalizationContext {
  const locale = input.locale ?? 'en-US';
  const { language, region } = parseLocale(locale);

  const dateOrder: DateOrder =
    input.dateOrder ?? (region !== undefined && MDY_REGIONS.has(region) ? 'MDY' : 'DMY');

  const currency =
    input.currency ??
    (region !== undefined ? REGION_CURRENCY[region] : undefined) ??
    LANGUAGE_DEFAULT_CURRENCY[language];

  const frenchNumbers: FrenchNumberSystem =
    input.frenchNumbers ?? (region === 'BE' ? 'belgian' : region === 'CH' ? 'swiss' : 'standard');

  return {
    locale,
    language,
    region,
    currency,
    register: input.register ?? 'formal',
    dateOrder,
    pauseStyle: input.pauseStyle ?? 'punctuation',
    ssml: input.ssml ?? false,
    digitGroupSize: input.digitGroupSize ?? 3,
    acronyms: input.acronyms ?? {},
    frenchNumbers,
    britishAnd: input.britishAnd ?? (language === 'en' && region !== 'US' && region !== 'CA'),
  };
}
