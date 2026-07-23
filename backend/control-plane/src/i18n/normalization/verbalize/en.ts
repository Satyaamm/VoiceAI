/**
 * English verbalizer.
 *
 * Number grammar: strictly positional, hyphenated compound tens, "and" before the final
 * two digits in British usage only ("one thousand two hundred AND thirty-four"), never
 * in American. `ctx.britishAnd` is derived from the region.
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

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'] as const;
const TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const;
const SCALES = [
  { value: 1_000_000_000_000, word: 'trillion' },
  { value: 1_000_000_000, word: 'billion' },
  { value: 1_000_000, word: 'million' },
  { value: 1000, word: 'thousand' },
] as const;

function under100(n: number): string {
  if (n < 10) return at(UNITS, n);
  if (n < 20) return at(TEENS, n - 10);
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? at(TENS, t) : `${at(TENS, t)}-${at(UNITS, u)}`;
}

function under1000(n: number, useAnd: boolean): string {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = `${at(UNITS, h)} hundred`;
  if (r === 0) return head;
  return useAnd ? `${head} and ${under100(r)}` : `${head} ${under100(r)}`;
}

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${cardinal(-n, ctx)}`;
  if (n === 0) return 'zero';
  if (!Number.isSafeInteger(n)) return String(n);

  const useAnd = ctx.britishAnd;
  const parts: string[] = [];
  let rest = n;
  for (const scale of SCALES) {
    if (rest >= scale.value) {
      const count = Math.floor(rest / scale.value);
      rest %= scale.value;
      parts.push(`${cardinal(count, ctx)} ${scale.word}`);
    }
  }
  if (rest > 0) {
    // British "and" also joins the final group: "one thousand and five".
    if (useAnd && parts.length > 0 && rest < 100) parts.push('and');
    parts.push(under1000(rest, useAnd));
  }
  return parts.join(' ');
}

const SMALL_ORDINALS: Readonly<Record<string, string>> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

function ordinalizeWord(word: string): string {
  const direct = SMALL_ORDINALS[word];
  if (direct !== undefined) return direct;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ieth`; // twenty -> twentieth
  const hyphen = word.lastIndexOf('-');
  if (hyphen > 0) return `${word.slice(0, hyphen + 1)}${ordinalizeWord(word.slice(hyphen + 1))}`;
  return `${word}th`;
}

function ordinal(n: number, ctx: NormalizationContext): string {
  const c = cardinal(n, ctx);
  const i = c.lastIndexOf(' ');
  return i < 0 ? ordinalizeWord(c) : `${c.slice(0, i + 1)}${ordinalizeWord(c.slice(i + 1))}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface CurrencyWords {
  readonly one: string;
  readonly many: string;
  readonly minorOne: string;
  readonly minorMany: string;
}

const CURRENCIES: Readonly<Record<string, CurrencyWords>> = {
  USD: { one: 'dollar', many: 'dollars', minorOne: 'cent', minorMany: 'cents' },
  EUR: { one: 'euro', many: 'euros', minorOne: 'cent', minorMany: 'cents' },
  GBP: { one: 'pound', many: 'pounds', minorOne: 'penny', minorMany: 'pence' },
  CHF: { one: 'Swiss franc', many: 'Swiss francs', minorOne: 'centime', minorMany: 'centimes' },
  JPY: { one: 'yen', many: 'yen', minorOne: 'sen', minorMany: 'sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'dot',
  slash: 'slash',
  dash: 'dash',
  at: 'at',
  underscore: 'underscore',
  colon: 'colon',
  plus: 'plus',
  question: 'question mark',
  hash: 'hash',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'kilogram', many: 'kilograms' },
  g: { one: 'gram', many: 'grams' },
  mg: { one: 'milligram', many: 'milligrams' },
  km: { one: 'kilometre', many: 'kilometres' },
  m: { one: 'metre', many: 'metres' },
  cm: { one: 'centimetre', many: 'centimetres' },
  mm: { one: 'millimetre', many: 'millimetres' },
  ml: { one: 'millilitre', many: 'millilitres' },
  l: { one: 'litre', many: 'litres' },
  h: { one: 'hour', many: 'hours' },
  hr: { one: 'hour', many: 'hours' },
  hrs: { one: 'hour', many: 'hours' },
  min: { one: 'minute', many: 'minutes' },
  s: { one: 'second', many: 'seconds' },
  sec: { one: 'second', many: 'seconds' },
  '°C': { one: 'degree Celsius', many: 'degrees Celsius' },
  '°F': { one: 'degree Fahrenheit', many: 'degrees Fahrenheit' },
  'km/h': { one: 'kilometre per hour', many: 'kilometres per hour' },
  kWh: { one: 'kilowatt hour', many: 'kilowatt hours' },
  MB: { one: 'megabyte', many: 'megabytes' },
  GB: { one: 'gigabyte', many: 'gigabytes' },
  TB: { one: 'terabyte', many: 'terabytes' },
  KB: { one: 'kilobyte', many: 'kilobytes' },
};

function digitWord(d: string): string {
  const n = Number.parseInt(d, 10);
  // "oh" for zero is idiomatic in readback but ambiguous with the letter O; we say "zero".
  return Number.isFinite(n) ? at(UNITS, n) : d;
}

function numericToWords(value: string, ctx: NormalizationContext): string {
  const cleaned = value.replace(/,/g, '').trim();
  const [intPart = '', fracPart = ''] = cleaned.split('.');
  const n = Number.parseInt(intPart === '' ? '0' : intPart, 10);
  if (fracPart.length === 0) return cardinal(n, ctx);
  return `${cardinal(n, ctx)} point ${fracPart.split('').map(digitWord).join(' ')}`;
}

/** `1st`, `22nd`, `3rd`, `4th`. */
const ORDINAL_SUFFIX_RE = /\b(\d{1,6})(st|nd|rd|th)\b/gi;

const extraRules: readonly Rule[] = [
  {
    kind: 'ordinal',
    pattern: ORDINAL_SUFFIX_RE,
    render: (m, ctx) => {
      const n = Number.parseInt(m[1] ?? '', 10);
      return Number.isFinite(n) ? ordinal(n, ctx) : null;
    },
  },
];

const formatter: LocaleFormatter = {
  language: 'en',
  groupSeparators: [',', ' ', ' '],
  decimalSeparator: '.',
  rangeWords: ['to', 'through'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} point ${frac.split('').map(digitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { one: code, many: code, minorOne: 'cent', minorMany: 'cents' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    const majorText = `${cardinal(major, ctx)} ${major === 1 ? words.one : words.many}`;
    if (minor === 0) return majorText;
    return `${majorText} and ${cardinal(minor, ctx)} ${minor === 1 ? words.minorOne : words.minorMany}`;
  },

  date(day, month, year, ctx) {
    // en-US says "October third"; en-GB says "the third of October". Both are understood
    // everywhere, so we follow the region rather than trying to be neutral.
    const monthName = at(MONTHS, month - 1);
    const dayText = ordinal(day, ctx);
    const head = ctx.region === 'US' ? `${monthName} ${dayText}` : `the ${dayText} of ${monthName}`;
    if (year === undefined) return head;
    // Year as a full cardinal ("two thousand twenty-six") rather than the pairwise
    // "twenty twenty-six". Slightly more formal, never ambiguous.
    return `${head}, ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    let h = hour;
    let mer = meridiem;
    if (mer === undefined && h > 12) {
      mer = 'pm';
      h -= 12;
    } else if (mer === undefined && h === 12) {
      mer = 'pm';
    } else if (mer === undefined && h === 0) {
      mer = 'am';
      h = 12;
    }
    if (mer !== undefined && h > 12) h -= 12;
    if (h === 0) h = 12;
    const suffix = mer === 'pm' ? ' PM' : mer === 'am' ? ' AM' : '';
    if (minute === 0) return `${cardinal(h, ctx)} o'clock${suffix}`;
    // "two oh five" for minutes under ten — the standard spoken form.
    const minText = minute < 10 ? `oh ${at(UNITS, minute)}` : under100(minute);
    return `${cardinal(h, ctx)} ${minText}${suffix}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // North American convention: 3 + 3 + 4, spelled digit by digit, pause between groups.
    const p = pause(ctx, 300);
    if (!hasCountryCode && digits.length === 10) {
      const a = digits.slice(0, 3);
      const b = digits.slice(3, 6);
      const c = digits.slice(6);
      return [a, b, c].map((g) => g.split('').map(digitWord).join(' ')).join(p);
    }
    if (hasCountryCode) {
      // We do not know the country's own grouping, so: country code, then groups of three.
      const cc = digits.slice(0, digits.length > 11 ? 2 : 1);
      const rest = digits.slice(cc.length);
      const groups = groupDigits(rest, 3).map((g) => g.split('').map(digitWord).join(' '));
      return [`plus ${cc.split('').map(digitWord).join(' ')}`, ...groups].join(p);
    }
    return groupDigits(digits, 3)
      .map((g) => g.split('').map(digitWord).join(' '))
      .join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} percent`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    const isOne = /^(one|minus one)$/.test(spoken);
    return `${spoken} ${isOne ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `${numericToWords(a, ctx)} to ${numericToWords(b, ctx)}`;
  },

  identifier(token, ctx) {
    // docs/03 3.7. Letters are spelled, digits are spelled, and the whole thing is broken
    // into groups with a pause so the caller can write it down.
    const p = pause(ctx, 300);
    const clean = token.replace(/-/g, '');
    const chunks = groupDigits(clean, ctx.digitGroupSize);
    return chunks
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
};

const rules = buildRules(formatter);

export const englishVerbalizer: Verbalizer = {
  name: 'verbalize:en',
  language: 'en',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default englishVerbalizer;
