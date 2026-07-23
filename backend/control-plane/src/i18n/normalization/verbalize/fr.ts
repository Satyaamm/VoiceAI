/**
 * French verbalizer.
 *
 * The interesting grammar:
 *  - VIGESIMAL 70/80/90. Standard (France, Québec) says "soixante-dix", "quatre-vingts",
 *    "quatre-vingt-dix". 71 is "soixante et onze" (with "et"), 81 is "quatre-vingt-un"
 *    (without). 99 is "quatre-vingt-dix-neuf".
 *  - REGIONAL VARIANTS. Belgium says "septante" (70) and "nonante" (90) but keeps
 *    "quatre-vingts" (80). Switzerland says "septante", "huitante" (80, in Vaud/Valais/
 *    Fribourg; Geneva says "quatre-vingts") and "nonante". `ctx.frenchNumbers` selects;
 *    it is derived from the region subtag (fr-BE, fr-CH).
 *    UNCERTAIN: the Geneva/Vaud split inside fr-CH is not representable from a BCP-47
 *    tag, so fr-CH gets "huitante". A tenant serving Geneva should override to 'belgian'.
 *  - AGREEMENT: "quatre-vingts" and "deux cents" take an -s only when nothing follows;
 *    "quatre-vingt-deux", "deux cent deux". "mille" is invariant.
 *  - Decimal comma; thousands separated by a (narrow) no-break space, not a dot.
 *
 * Not handled here: liaison (docs/13 §4 mentions it). Liaison is a TTS-side phonetic
 * phenomenon — "deux euros" is /dø.zø.ʁo/ — and we cannot force it from orthography.
 * What we CAN do is never emit a form that blocks it, which is why we spell numbers out
 * as words rather than leaving digits for the TTS front-end to guess at.
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

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'] as const;
const TEN_TO_SIXTEEN = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'] as const;
const TENS = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'] as const;

/**
 * The decade word, or null when this variant has no simple word for it and must build
 * the decade vigesimally (standard French 70/80/90; Belgian 80).
 */
function decadeWord(t: number, system: NormalizationContext['frenchNumbers']): string | null {
  if (t >= 2 && t <= 6) return at(TENS, t);
  if (t === 7) return system === 'standard' ? null : 'septante';
  if (t === 8) return system === 'swiss' ? 'huitante' : null;
  if (t === 9) return system === 'standard' ? null : 'nonante';
  return null;
}

function under100(n: number, ctx: NormalizationContext): string {
  if (n < 10) return at(UNITS, n);
  if (n <= 16) return at(TEN_TO_SIXTEEN, n - 10);
  if (n < 20) return `dix-${at(UNITS, n - 10)}`;

  const system = ctx.frenchNumbers;
  const t = Math.floor(n / 10);
  const u = n % 10;

  const base = decadeWord(t, system);
  if (base !== null) {
    if (u === 0) return base;
    // "vingt et un", "septante et un".
    // UNCERTAIN: Swiss "huitante" is more often written "huitante-un"; we keep "et un".
    if (u === 1) return `${base} et un`;
    return `${base}-${at(UNITS, u)}`;
  }

  if (t === 7) {
    // Standard 70–79: soixante + 10..19. 71 keeps the "et": "soixante et onze".
    const r = n - 60;
    return r === 11 ? 'soixante et onze' : `soixante-${under100(r, ctx)}`;
  }

  // 80–99 without huitante/nonante: quatre-vingt(s) + 0..19. No "et" at 81.
  if (n === 80) return 'quatre-vingts';
  const r = n - 80;
  return r < 10 ? `quatre-vingt-${at(UNITS, r)}` : `quatre-vingt-${under100(r, ctx)}`;
}

function under1000(n: number, ctx: NormalizationContext): string {
  if (n < 100) return under100(n, ctx);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 1 ? 'cent' : `${at(UNITS, h)} cent`;
  // "deux cents" but "deux cent trois".
  if (r === 0) return h === 1 ? 'cent' : `${head}s`;
  return `${head} ${under100(r, ctx)}`;
}

const BIG_SCALES = [
  { value: 1_000_000_000_000, one: 'un billion', many: 'billions' },
  { value: 1_000_000_000, one: 'un milliard', many: 'milliards' },
  { value: 1_000_000, one: 'un million', many: 'millions' },
] as const;

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `moins ${cardinal(-n, ctx)}`;
  if (!Number.isSafeInteger(n)) return String(n);
  if (n === 0) return 'zéro';

  for (const scale of BIG_SCALES) {
    if (n >= scale.value) {
      const count = Math.floor(n / scale.value);
      const rest = n % scale.value;
      const head = count === 1 ? scale.one : `${cardinal(count, ctx)} ${scale.many}`;
      return rest === 0 ? head : `${head} ${cardinal(rest, ctx)}`;
    }
  }

  if (n >= 1000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    // "mille" is invariant: "deux mille", never "deux milles".
    const head = th === 1 ? 'mille' : `${under1000(th, ctx)} mille`;
    return r === 0 ? head : `${head} ${under1000(r, ctx)}`;
  }
  return under1000(n, ctx);
}

/**
 * Ordinals: 1 is "premier"/"première"; everything else takes -ième on the cardinal,
 * with the usual spelling adjustments (quatre -> quatrième, cinq -> cinquième,
 * neuf -> neuvième, vingt et un -> vingt et unième).
 *
 * UNCERTAIN: gender. "premier" vs "première" depends on the noun. We emit the masculine
 * "premier" because the common cases in a call ("le premier mars", "le premier étage")
 * are masculine; a tenant needing "première" can add a lexicon entry.
 */
function ordinalizeWord(word: string): string {
  let w = word;
  if (w.endsWith('s')) w = w.slice(0, -1); // cents -> cent, quatre-vingts -> quatre-vingt
  if (w === 'cinq') return 'cinquième';
  if (w === 'neuf') return 'neuvième';
  if (w === 'un') return 'unième';
  if (w.endsWith('e')) w = w.slice(0, -1); // quatre -> quatr, mille -> mill
  return `${w}ième`;
}

function ordinal(n: number, ctx: NormalizationContext): string {
  if (n === 1) return 'premier';
  const c = cardinal(n, ctx);
  const i = Math.max(c.lastIndexOf(' '), c.lastIndexOf('-'));
  return i < 0 ? ordinalizeWord(c) : `${c.slice(0, i + 1)}${ordinalizeWord(c.slice(i + 1))}`;
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

const CURRENCIES: Readonly<Record<string, { one: string; many: string; minorOne: string; minorMany: string }>> = {
  EUR: { one: 'euro', many: 'euros', minorOne: 'centime', minorMany: 'centimes' },
  USD: { one: 'dollar', many: 'dollars', minorOne: 'cent', minorMany: 'cents' },
  GBP: { one: 'livre sterling', many: 'livres sterling', minorOne: 'penny', minorMany: 'pence' },
  CHF: { one: 'franc suisse', many: 'francs suisses', minorOne: 'centime', minorMany: 'centimes' },
  JPY: { one: 'yen', many: 'yens', minorOne: 'sen', minorMany: 'sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'point',
  // UNCERTAIN: "barre oblique" is the correct term; in speech the English "slash" is
  // at least as common and much shorter. We use "slash" — brevity matters on a call.
  slash: 'slash',
  dash: 'tiret',
  at: 'arobase',
  underscore: 'tiret bas',
  colon: 'deux-points',
  plus: 'plus',
  question: "point d'interrogation",
  hash: 'dièse',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'kilogramme', many: 'kilogrammes' },
  g: { one: 'gramme', many: 'grammes' },
  mg: { one: 'milligramme', many: 'milligrammes' },
  km: { one: 'kilomètre', many: 'kilomètres' },
  m: { one: 'mètre', many: 'mètres' },
  cm: { one: 'centimètre', many: 'centimètres' },
  mm: { one: 'millimètre', many: 'millimètres' },
  ml: { one: 'millilitre', many: 'millilitres' },
  l: { one: 'litre', many: 'litres' },
  h: { one: 'heure', many: 'heures' },
  min: { one: 'minute', many: 'minutes' },
  s: { one: 'seconde', many: 'secondes' },
  sec: { one: 'seconde', many: 'secondes' },
  '°C': { one: 'degré Celsius', many: 'degrés Celsius' },
  '°F': { one: 'degré Fahrenheit', many: 'degrés Fahrenheit' },
  'km/h': { one: 'kilomètre-heure', many: 'kilomètres-heure' },
  kWh: { one: 'kilowattheure', many: 'kilowattheures' },
  MB: { one: 'mégaoctet', many: 'mégaoctets' },
  GB: { one: 'gigaoctet', many: 'gigaoctets' },
  TB: { one: 'téraoctet', many: 'téraoctets' },
  KB: { one: 'kilooctet', many: 'kilooctets' },
};

function digitWord(d: string): string {
  const n = Number.parseInt(d, 10);
  return Number.isFinite(n) ? at(UNITS, n) : d;
}

function numericToWords(value: string, ctx: NormalizationContext): string {
  const cleaned = value.replace(/[   .]/g, '').trim();
  const [intPart = '', fracPart = ''] = cleaned.split(',');
  const n = Number.parseInt(intPart === '' ? '0' : intPart, 10);
  if (fracPart.length === 0) return cardinal(n, ctx);
  return `${cardinal(n, ctx)} virgule ${fracPart.split('').map(digitWord).join(' ')}`;
}

/** `14h30`, `9 h`, `14 h 05` — the French clock notation. Must precede the date rule. */
const CLOCK_H_RE = /\b(\d{1,2})\s?h\s?([0-5]\d)?\b/g;
/** `1er`, `1re`, `2e`, `3ème`. */
const ORDINAL_SUFFIX_RE = /\b(\d{1,6})\s?(?:ers?|ères?|res?|èmes?|ièmes?|es?)\b/g;

const extraRules: readonly Rule[] = [
  {
    kind: 'time',
    pattern: CLOCK_H_RE,
    render: (m, ctx) => {
      const h = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(h) || h > 23) return null;
      const min = m[2] === undefined ? 0 : Number.parseInt(m[2], 10);
      const hourWord = h === 1 ? 'une heure' : `${cardinal(h, ctx)} heures`;
      return min === 0 ? hourWord : `${hourWord} ${cardinal(min, ctx)}`;
    },
  },
  {
    kind: 'ordinal',
    pattern: ORDINAL_SUFFIX_RE,
    render: (m, ctx) => {
      const n = Number.parseInt(m[1] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? ordinal(n, ctx) : null;
    },
  },
];

const formatter: LocaleFormatter = {
  language: 'fr',
  // French groups thousands with a space (narrow no-break in typography). A dot is not
  // a French group separator, but LLMs emit "1.234" anyway, so we accept it.
  groupSeparators: [' ', ' ', ' ', '.'],
  decimalSeparator: ',',
  rangeWords: ['à', 'a'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} virgule ${frac.split('').map(digitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { one: code, many: code, minorOne: 'centime', minorMany: 'centimes' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    const head = `${cardinal(major, ctx)} ${major === 1 ? words.one : words.many}`;
    if (minor === 0) return head;
    // "douze euros cinquante" — the natural spoken elision of "et cinquante centimes".
    return `${head} ${cardinal(minor, ctx)}`;
  },

  date(day, month, year, ctx) {
    // 10/03/2026 is 10 March. French says the cardinal for every day except the first:
    // "le premier mars", "le dix mars".
    const dayWord = day === 1 ? 'premier' : cardinal(day, ctx);
    const head = `${dayWord} ${at(MONTHS, month - 1)}`;
    return year === undefined ? head : `${head} ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    let h = hour;
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    const hourWord = h === 1 ? 'une heure' : h === 0 ? 'zéro heure' : `${cardinal(h, ctx)} heures`;
    return minute === 0 ? hourWord : `${hourWord} ${cardinal(minute, ctx)}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // THE French convention: numbers are read in two-digit PAIRS as numbers, not digits.
    // 06 12 34 56 78 -> "zéro six, douze, trente-quatre, cinquante-six, soixante-dix-huit".
    // Getting this wrong ("zéro six un deux trois quatre…") instantly marks an agent as foreign.
    const p = pause(ctx, 300);
    const parts: string[] = [];
    let rest = digits;
    if (hasCountryCode) {
      const cc = digits.startsWith('33') ? '33' : digits.slice(0, digits.length > 11 ? 2 : 1);
      parts.push(`plus ${cc.split('').map(digitWord).join(' ')}`);
      rest = digits.slice(cc.length);
      // A national number quoted with +33 drops its leading 0; put it back for pairing.
      if (cc === '33' && rest.length === 9) rest = `0${rest}`;
    }
    for (const g of groupDigits(rest, 2)) {
      if (g.length === 2 && g.startsWith('0')) {
        // "06" is "zéro six", not "six".
        parts.push(`${digitWord('0')} ${digitWord(g[1] ?? '0')}`);
      } else if (g.length === 2) {
        parts.push(cardinal(Number.parseInt(g, 10), ctx));
      } else {
        parts.push(g.split('').map(digitWord).join(' '));
      }
    }
    return parts.join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} pour cent`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    return `${spoken} ${spoken === 'un' ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `${numericToWords(a, ctx)} à ${numericToWords(b, ctx)}`;
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
};

const rules = buildRules(formatter);

export const frenchVerbalizer: Verbalizer = {
  name: 'verbalize:fr',
  language: 'fr',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default frenchVerbalizer;
