/**
 * German verbalizer.
 *
 * The number grammar is the reason this file exists (docs/13 §4 — "German compound nouns
 * and number formats … this is where most platforms are visibly bad"):
 *
 *  - UNITS BEFORE TENS, joined by "und": 21 -> "einundzwanzig", 42 -> "zweiundvierzig".
 *  - EVERYTHING BELOW A MILLION IS ONE WORD: 1234 -> "eintausendzweihundertvierunddreißig".
 *  - The standalone "eins" becomes the combining form "ein" inside a compound:
 *    1 -> "eins" but 21 -> "einundzwanzig", 100 -> "einhundert", 101 -> "einhunderteins".
 *  - Irregular stems: 16 "sechzehn" (not sechszehn), 17 "siebzehn" (not siebenzehn),
 *    60 "sechzig", 70 "siebzig", 30 "dreißig" (ß, not "dreissig" — Swiss orthography
 *    would write "dreissig"; we do not branch on de-CH, see the note below).
 *  - Million and above are separate FEMININE nouns with their own plural:
 *    "eine Million", "zwei Millionen", "eine Milliarde".
 *
 * Decimal comma: German writes 1.234,50. Reading "1.234" as "one point two three four"
 * is the classic, embarrassing failure this module exists to prevent — here `.` is a
 * thousands separator and `,` is the decimal point.
 */

import type { NormalizationContext, Verbalizer } from '../types.js';
import {
  at,
  buildRules,
  defaultAcronym,
  groupDigits,
  minorUnits,
  pause,
  runRules,
  speakEmail,
  speakUrl,
  type LocaleFormatter,
  type Rule,
  type UrlWords,
} from './shared.js';

/** Standalone forms. Index 1 is "eins". */
const UNITS_STANDALONE = [
  'null',
  'eins',
  'zwei',
  'drei',
  'vier',
  'fünf',
  'sechs',
  'sieben',
  'acht',
  'neun',
] as const;

/** Combining forms used inside compounds. Index 1 is "ein". */
const UNITS_COMBINING = [
  'null',
  'ein',
  'zwei',
  'drei',
  'vier',
  'fünf',
  'sechs',
  'sieben',
  'acht',
  'neun',
] as const;

const TEENS = [
  'zehn',
  'elf',
  'zwölf',
  'dreizehn',
  'vierzehn',
  'fünfzehn',
  'sechzehn',
  'siebzehn',
  'achtzehn',
  'neunzehn',
] as const;

const TENS = [
  '',
  '',
  'zwanzig',
  'dreißig',
  'vierzig',
  'fünfzig',
  'sechzig',
  'siebzig',
  'achtzig',
  'neunzig',
] as const;

/**
 * @param standalone true when the number ends here, so 1 is "eins" rather than "ein".
 */
function under100(n: number, standalone: boolean): string {
  if (n < 10) return standalone ? at(UNITS_STANDALONE, n) : at(UNITS_COMBINING, n);
  if (n < 20) return at(TEENS, n - 10);
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return at(TENS, t);
  // The whole point: unit + "und" + ten, as a single word.
  return `${at(UNITS_COMBINING, u)}und${at(TENS, t)}`;
}

function under1000(n: number, standalone: boolean): string {
  if (n < 100) return under100(n, standalone);
  const h = Math.floor(n / 100);
  const r = n % 100;
  // "einhundert" rather than the colloquial bare "hundert": unambiguous on a phone line.
  const head = `${at(UNITS_COMBINING, h)}hundert`;
  return r === 0 ? head : `${head}${under100(r, standalone)}`;
}

function underMillion(n: number, standalone: boolean): string {
  if (n < 1000) return under1000(n, standalone);
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  // "eintausend", "einundzwanzigtausend" — the multiplier uses combining forms.
  const head = `${under1000(th, false)}tausend`;
  return r === 0 ? head : `${head}${under1000(r, standalone)}`;
}

const BIG_SCALES = [
  { value: 1_000_000_000_000, one: 'eine Billion', many: 'Billionen' },
  { value: 1_000_000_000, one: 'eine Milliarde', many: 'Milliarden' },
  { value: 1_000_000, one: 'eine Million', many: 'Millionen' },
] as const;

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${cardinal(-n, ctx)}`;
  if (!Number.isSafeInteger(n)) return String(n);
  if (n === 0) return 'null';

  for (const scale of BIG_SCALES) {
    if (n >= scale.value) {
      const count = Math.floor(n / scale.value);
      const rest = n % scale.value;
      const head = count === 1 ? scale.one : `${underMillion(count, false)} ${scale.many}`;
      return rest === 0 ? head : `${head} ${cardinal(rest, ctx)}`;
    }
  }
  return underMillion(n, true);
}

/**
 * Ordinals: -te up to 19, -ste from 20, applied to the LAST constituent.
 * 101. -> "einhunderterste". Irregulars: erste, dritte, siebte, achte.
 *
 * UNCERTAIN: German ordinals decline for case/gender/definiteness ("der zehnte" vs
 * "ein zehnter" vs "am zehnten"). We cannot know the syntactic slot from the digit
 * string, so we emit the weak/-e form, which is what a listener expects after a
 * definite article and is the least jarring in isolation.
 */
const SMALL_ORDINALS = [
  '',
  'erste',
  'zweite',
  'dritte',
  'vierte',
  'fünfte',
  'sechste',
  'siebte',
  'achte',
  'neunte',
  'zehnte',
  'elfte',
  'zwölfte',
  'dreizehnte',
  'vierzehnte',
  'fünfzehnte',
  'sechzehnte',
  'siebzehnte',
  'achtzehnte',
  'neunzehnte',
] as const;

function ordinal(n: number, ctx: NormalizationContext): string {
  if (n <= 0 || !Number.isSafeInteger(n)) return cardinal(n, ctx);
  const last2 = n % 100;
  if (last2 !== 0 && last2 < 20) {
    const head = n - last2;
    const prefix = head === 0 ? '' : cardinal(head, ctx).replace(/\s+$/, '');
    return `${prefix}${at(SMALL_ORDINALS, last2)}`;
  }
  return `${cardinal(n, ctx)}ste`;
}

const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
] as const;

const CURRENCIES: Readonly<Record<string, { unit: string; minor: string }>> = {
  // "Euro" and "Cent" are invariant after a numeral in standard German usage
  // ("zwei Euro", not "zwei Euros").
  EUR: { unit: 'Euro', minor: 'Cent' },
  USD: { unit: 'US-Dollar', minor: 'Cent' },
  GBP: { unit: 'Pfund', minor: 'Pence' },
  CHF: { unit: 'Franken', minor: 'Rappen' },
  JPY: { unit: 'Yen', minor: 'Sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'Punkt',
  slash: 'Schrägstrich',
  dash: 'Bindestrich',
  // UNCERTAIN: Germans overwhelmingly say the English "at" (often written "ät") for @.
  // "Klammeraffe" is technically correct and sounds archaic on a support line.
  at: 'at',
  underscore: 'Unterstrich',
  colon: 'Doppelpunkt',
  plus: 'Plus',
  question: 'Fragezeichen',
  hash: 'Raute',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'Kilogramm', many: 'Kilogramm' },
  g: { one: 'Gramm', many: 'Gramm' },
  mg: { one: 'Milligramm', many: 'Milligramm' },
  km: { one: 'Kilometer', many: 'Kilometer' },
  m: { one: 'Meter', many: 'Meter' },
  cm: { one: 'Zentimeter', many: 'Zentimeter' },
  mm: { one: 'Millimeter', many: 'Millimeter' },
  ml: { one: 'Milliliter', many: 'Milliliter' },
  l: { one: 'Liter', many: 'Liter' },
  h: { one: 'Stunde', many: 'Stunden' },
  std: { one: 'Stunde', many: 'Stunden' },
  min: { one: 'Minute', many: 'Minuten' },
  s: { one: 'Sekunde', many: 'Sekunden' },
  sec: { one: 'Sekunde', many: 'Sekunden' },
  '°C': { one: 'Grad Celsius', many: 'Grad Celsius' },
  '°F': { one: 'Grad Fahrenheit', many: 'Grad Fahrenheit' },
  'km/h': { one: 'Stundenkilometer', many: 'Stundenkilometer' },
  kWh: { one: 'Kilowattstunde', many: 'Kilowattstunden' },
  MB: { one: 'Megabyte', many: 'Megabyte' },
  GB: { one: 'Gigabyte', many: 'Gigabyte' },
  TB: { one: 'Terabyte', many: 'Terabyte' },
  KB: { one: 'Kilobyte', many: 'Kilobyte' },
};

function digitWord(d: string): string {
  const n = Number.parseInt(d, 10);
  if (!Number.isFinite(n)) return d;
  // "zwo" instead of "zwei" is the German telephony convention for 2, because "zwei"
  // and "drei" are confusable over a narrowband line. Used ONLY in digit-by-digit
  // readback, never inside a real number word.
  if (n === 2) return 'zwo';
  return at(UNITS_STANDALONE, n);
}

function plainDigitWord(d: string): string {
  const n = Number.parseInt(d, 10);
  return Number.isFinite(n) ? at(UNITS_STANDALONE, n) : d;
}

function numericToWords(value: string, ctx: NormalizationContext): string {
  const cleaned = value.replace(/[.   ]/g, '').trim();
  const [intPart = '', fracPart = ''] = cleaned.split(',');
  const n = Number.parseInt(intPart === '' ? '0' : intPart, 10);
  if (fracPart.length === 0) return cardinal(n, ctx);
  return `${cardinal(n, ctx)} Komma ${fracPart.split('').map(plainDigitWord).join(' ')}`;
}

/**
 * `14.30 Uhr` / `14 Uhr 30`. Must run before the date rule, otherwise `14.30` is a
 * candidate day/month pair.
 */
const CLOCK_UHR_RE = /\b(\d{1,2})(?:[.:](\d{2}))?\s?Uhr(?:\s(\d{1,2}))?\b/g;

/**
 * Bare German ordinal `3.`.
 *
 * UNCERTAIN / deliberately conservative: `5.` is also just a sentence-final number.
 * We only fire when the dot is followed by whitespace and another word inside the same
 * clause, and the number is ≤ 999. Ordered-list markers at line start were already
 * removed by the sanitizer, which is where most false positives would come from.
 */
const BARE_ORDINAL_RE = /\b(\d{1,3})\.(?=\s+\p{L})/gu;

const extraRules: readonly Rule[] = [
  {
    kind: 'time',
    pattern: CLOCK_UHR_RE,
    render: (m, ctx) => {
      const h = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(h) || h > 23) return null;
      const minRaw = m[2] ?? m[3];
      const min = minRaw === undefined ? 0 : Number.parseInt(minRaw, 10);
      if (min > 59) return null;
      return min === 0 ? `${cardinal(h, ctx)} Uhr` : `${cardinal(h, ctx)} Uhr ${cardinal(min, ctx)}`;
    },
  },
];

const lateRules: readonly Rule[] = [
  {
    kind: 'ordinal',
    pattern: BARE_ORDINAL_RE,
    render: (m, ctx) => {
      const n = Number.parseInt(m[1] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? ordinal(n, ctx) : null;
    },
  },
];

const formatter: LocaleFormatter = {
  language: 'de',
  // `.` and the (narrow) no-break space are thousands separators in German.
  groupSeparators: ['.', ' ', ' ', ' '],
  decimalSeparator: ',',
  rangeWords: ['bis'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} Komma ${frac.split('').map(plainDigitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { unit: code, minor: 'Cent' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    // "ein Euro", not "eins Euro" — the numeral is attributive here.
    const majorWord = major === 1 ? 'ein' : cardinal(major, ctx);
    const head = `${majorWord} ${words.unit}`;
    if (minor === 0) return head;
    // "zwölf Euro fünfzig" is how a German speaker actually says a price. The explicit
    // "… und fünfzig Cent" is also correct but noticeably stiffer.
    return `${head} ${cardinal(minor, ctx)}`;
  },

  date(day, month, year, ctx) {
    // Written 10.03.2026, spoken "zehnter März zweitausendsechsundzwanzig".
    // UNCERTAIN: in a sentence this is nearly always dative ("am zehnten März").
    // Standing alone we use the nominative -er form; see the ordinal() note.
    const head = `${ordinal(day, ctx).replace(/e$/, 'er')} ${at(MONTHS, month - 1)}`;
    return year === undefined ? head : `${head} ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    // German is a 24-hour culture; an am/pm marker in the LLM output is folded in.
    let h = hour;
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    return minute === 0 ? `${cardinal(h, ctx)} Uhr` : `${cardinal(h, ctx)} Uhr ${cardinal(minute, ctx)}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // German numbers have no fixed national grouping (area codes are 2–5 digits), so
    // readback is digit by digit in pairs — the convention Germans use themselves —
    // with the country code called out separately.
    const p = pause(ctx, 300);
    const parts: string[] = [];
    let rest = digits;
    if (hasCountryCode) {
      const cc = digits.startsWith('49') ? '49' : digits.slice(0, digits.length > 11 ? 2 : 1);
      parts.push(`plus ${cc.split('').map(digitWord).join(' ')}`);
      rest = digits.slice(cc.length);
    }
    for (const g of groupDigits(rest, 2)) parts.push(g.split('').map(digitWord).join(' '));
    return parts.join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} Prozent`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    // "ein Meter" not "eins Meter".
    const isOne = spoken === 'eins';
    return `${isOne ? 'ein' : spoken} ${isOne ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `${numericToWords(a, ctx)} bis ${numericToWords(b, ctx)}`;
  },

  identifier(token, ctx) {
    const p = pause(ctx, 300);
    const clean = token.replace(/-/g, '');
    return groupDigits(clean, ctx.digitGroupSize)
      .map((chunk) =>
        chunk
          .split('')
          .map((ch) => (/\d/.test(ch) ? digitWord(ch) : ch.toUpperCase()))
          .join(' '),
      )
      .join(p);
  },

  acronym(token, ctx) {
    return defaultAcronym(token, ctx);
  },

  extraRules,
  lateRules,
};

const rules = buildRules(formatter);

export const germanVerbalizer: Verbalizer = {
  name: 'verbalize:de',
  language: 'de',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default germanVerbalizer;
