/**
 * Verbalizer plumbing shared by every language.
 *
 * WHAT LIVES HERE: detection. The regexes that find "a currency amount", "a date",
 * "a phone number" in a clause, and the segment engine that rewrites non-overlapping
 * matches in one linear pass.
 *
 * WHAT DOES NOT LIVE HERE: grammar. Every language module implements {@link LocaleFormatter}
 * itself — German units-before-tens, French vigesimal, Dutch `eenentwintig`, Italian
 * vowel elision. There is deliberately no shared number-to-words routine, because there
 * is no shared number grammar.
 */

import type { NormalizationContext, TransformKind, TransformSink } from '../types.js';

// ---------------------------------------------------------------------------
// Segment engine
// ---------------------------------------------------------------------------

/**
 * A chunk of the clause. `done: true` means some rule already produced this text and
 * no later rule may touch it — which is what stops "one thousand" from being re-scanned
 * as a number, without any placeholder-encoding hack.
 */
export interface Segment {
  text: string;
  done: boolean;
}

export interface Rule {
  readonly kind: TransformKind;
  /** Must carry the `g` flag. */
  readonly pattern: RegExp;
  /** Return `null` to reject the match and leave the span for later rules. */
  render(m: RegExpMatchArray, ctx: NormalizationContext): string | null;
}

export function applyRule(segs: Segment[], rule: Rule, ctx: NormalizationContext, sink: TransformSink): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    if (seg.done || seg.text.length === 0) {
      out.push(seg);
      continue;
    }
    rule.pattern.lastIndex = 0;
    let last = 0;
    let changed = false;
    for (const m of seg.text.matchAll(rule.pattern)) {
      const idx = m.index;
      if (idx === undefined || idx < last) continue;
      const replaced = rule.render(m, ctx);
      if (replaced === null) continue;
      if (idx > last) out.push({ text: seg.text.slice(last, idx), done: false });
      out.push({ text: replaced, done: true });
      sink({ stage: 'verbalize', kind: rule.kind, source: m[0], output: replaced });
      last = idx + m[0].length;
      changed = true;
    }
    if (!changed) {
      out.push(seg);
    } else if (last < seg.text.length) {
      out.push({ text: seg.text.slice(last), done: false });
    }
  }
  return out;
}

export function runRules(
  text: string,
  rules: readonly Rule[],
  ctx: NormalizationContext,
  sink: TransformSink,
): string {
  let segs: Segment[] = [{ text, done: false }];
  for (const rule of rules) segs = applyRule(segs, rule, ctx, sink);
  return segs.map((s) => s.text).join('');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function at(arr: readonly string[], i: number): string {
  return arr[i] ?? '';
}

/** A readback pause (docs/03 3.7). Comma by default; `<break/>` when SSML is available. */
export function pause(ctx: NormalizationContext, ms = 250): string {
  return ctx.pauseStyle === 'ssml' && ctx.ssml ? `<break time="${ms}ms"/> ` : ', ';
}

/** Split a digit string into readback groups: `4273916` @3 -> ["427","391","6"]. */
export function groupDigits(digits: string, size: number): string[] {
  const groups: string[] = [];
  const n = Math.max(2, size);
  for (let i = 0; i < digits.length; i += n) groups.push(digits.slice(i, i + n));
  // Avoid a lonely trailing digit: "427 391 6" reads badly, "427 3916" does not.
  if (groups.length > 1) {
    const lastIdx = groups.length - 1;
    const lastGroup = groups[lastIdx] ?? '';
    const prev = groups[lastIdx - 1] ?? '';
    if (lastGroup.length === 1) {
      groups[lastIdx - 1] = prev + lastGroup;
      groups.pop();
    }
  }
  return groups;
}

/** Strip locale group separators, return integer and fraction parts as digit strings. */
export function splitAmount(raw: string, groupSep: readonly string[], decimalSep: string): { int: string; frac: string } {
  let s = raw.trim();
  for (const g of groupSep) s = s.split(g).join('');
  const i = s.lastIndexOf(decimalSep);
  if (i < 0) return { int: s.replace(/\D/g, ''), frac: '' };
  return { int: s.slice(0, i).replace(/\D/g, ''), frac: s.slice(i + 1).replace(/\D/g, '') };
}

/** Two decimal places -> minor-unit integer. `5` -> 50 cents, `05` -> 5 cents. */
export function minorUnits(frac: string): number {
  if (frac.length === 0) return 0;
  const two = (frac + '00').slice(0, 2);
  return Number.parseInt(two, 10);
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function plausibleDate(day: number, month: number, year?: number): boolean {
  if (month < 1 || month > 12) return false;
  const max = month === 2 && year !== undefined && !isLeapYear(year) ? 28 : (MONTH_LENGTHS[month - 1] ?? 31);
  return day >= 1 && day <= max;
}

/** Two-digit years: 00–69 -> 2000s, 70–99 -> 1900s. The usual POSIX window. */
export function expandYear(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (raw.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

// ---------------------------------------------------------------------------
// URL / email speaking (docs/03 3.4)
//
// The decomposition is identical in every language; only the words for `.`, `/`, `@`
// differ, so those come in from the language module. This is lexical substitution,
// not grammar, which is why it can be shared.
// ---------------------------------------------------------------------------

/** Spell a token letter by letter, e.g. `HR` -> "H R". */
export function spellLetters(token: string, gap = ' '): string {
  return token.toUpperCase().split('').join(gap);
}

function speakLabel(label: string, w: UrlWords, digitWord: (d: string) => string): string {
  // A label that is all digits is read digit by digit; `2` in a hostname is not "two
  // hundred" territory but it is also not a quantity.
  if (/^\d+$/.test(label)) return label.split('').map(digitWord).join(' ');
  // A single letter is spelled, not read as a word ("a" -> "A").
  if (label.length === 1) return label.toUpperCase();
  return label
    .replace(/-/g, ` ${w.dash} `)
    .replace(/_/g, ` ${w.underscore} `)
    .replace(/\s{2,}/g, ' ');
}

function speakHost(host: string, w: UrlWords, digitWord: (d: string) => string): string {
  return host
    .split('.')
    .filter((l) => l.length > 0)
    .map((l) => speakLabel(l, w, digitWord))
    .join(` ${w.dot} `);
}

/**
 * `https://acme.com/help` -> "acme dot com slash help".
 *
 * The scheme is dropped entirely: nobody wants "h t t p s colon slash slash", and a
 * caller told to visit "acme dot com slash help" will type the right thing. `www.` is
 * dropped for the same reason. Trailing punctuation that belongs to the sentence
 * (`.`, `,`, `)`) is handed back so the clause keeps its prosody.
 */
export function speakUrl(raw: string, w: UrlWords, digitWord: (d: string) => string): string {
  let s = raw;
  let trailing = '';
  const trail = /[.,;:!?)\]]+$/.exec(s);
  if (trail) {
    trailing = trail[0];
    s = s.slice(0, s.length - trailing.length);
  }
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]{0,15}:\/\//, '').replace(/^www\./i, '');
  if (s.length === 0) return raw;

  const slash = s.indexOf('/');
  const host = slash < 0 ? s : s.slice(0, slash);
  const rest = slash < 0 ? '' : s.slice(slash + 1);

  const parts: string[] = [speakHost(host, w, digitWord)];
  if (rest.length > 0) {
    const [pathPart = '', queryPart = ''] = rest.split('?', 2);
    for (const seg of pathPart.split('/')) {
      parts.push(w.slash);
      if (seg.length > 0) parts.push(speakLabel(seg.replace(/\./g, ` ${w.dot} `), w, digitWord));
    }
    if (queryPart.length > 0) {
      parts.push(w.question, speakLabel(queryPart.replace(/[=&]/g, ' '), w, digitWord));
    }
  }
  return parts.join(' ').replace(/\s{2,}/g, ' ').trim() + trailing;
}

/** `j.smith@acme.com` -> "J dot smith at acme dot com". */
export function speakEmail(local: string, domain: string, w: UrlWords, digitWord: (d: string) => string): string {
  const localSpoken = local
    .split('.')
    .filter((l) => l.length > 0)
    .map((l) => speakLabel(l, w, digitWord))
    .join(` ${w.dot} `);
  return `${localSpoken} ${w.at} ${speakHost(domain, w, digitWord)}`.replace(/\s{2,}/g, ' ');
}

// ---------------------------------------------------------------------------
// The per-language contract
// ---------------------------------------------------------------------------

export interface UrlWords {
  readonly dot: string;
  readonly slash: string;
  readonly dash: string;
  readonly at: string;
  readonly underscore: string;
  readonly colon: string;
  readonly plus: string;
  readonly question: string;
  readonly hash: string;
}

export interface LocaleFormatter {
  readonly language: string;
  /** Thousands separators accepted in written input for this locale. */
  readonly groupSeparators: readonly string[];
  readonly decimalSeparator: string;
  /** Word connectors that mean "from X to Y". */
  readonly rangeWords: readonly string[];
  readonly urlWords: UrlWords;

  cardinal(n: number, ctx: NormalizationContext): string;
  ordinal(n: number, ctx: NormalizationContext): string;
  /** Digit as a word, for spelled-out readback. */
  digitWord(d: string, ctx: NormalizationContext): string;
  /** `3,5` -> "drei Komma fünf". */
  decimal(int: string, frac: string, ctx: NormalizationContext): string;
  currency(int: string, frac: string, code: string, ctx: NormalizationContext): string;
  date(day: number, month: number, year: number | undefined, ctx: NormalizationContext): string;
  time(hour: number, minute: number, meridiem: 'am' | 'pm' | undefined, ctx: NormalizationContext): string;
  phone(digits: string, hasCountryCode: boolean, ctx: NormalizationContext): string;
  url(raw: string, ctx: NormalizationContext): string;
  email(local: string, domain: string, ctx: NormalizationContext): string;
  percent(value: string, ctx: NormalizationContext): string;
  unit(value: string, unit: string, ctx: NormalizationContext): string;
  range(a: string, b: string, ctx: NormalizationContext): string;
  /** Order IDs, reference numbers: spelled out and grouped with pauses (docs/03 3.7). */
  identifier(token: string, ctx: NormalizationContext): string;
  /** Return `null` to leave the token alone. */
  acronym(token: string, ctx: NormalizationContext): string | null;
  /** Language-specific patterns inserted before the generic ones (ordinals, `14h30`, …). */
  extraRules?: readonly Rule[];
  /** Language-specific patterns appended after the generic ones. */
  lateRules?: readonly Rule[];
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;

const URL_RE =
  /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]{2,300}|\b[A-Za-z0-9-]{2,63}(?:\.[A-Za-z0-9-]{2,63}){0,3}\.(?:com|net|org|edu|gov|info|biz|io|co|ai|app|dev|shop|de|fr|es|it|nl|be|at|ch|eu|uk|ie|pt|se|dk|no|fi|pl)(?:\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]{0,300})?/gi;

/** `14:30`, `2:30 pm`, `09:15:00`. */
const TIME_RE = /\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\s*([ap])\.?\s?m\.?)?/gi;
/** `3pm`, `11 a.m.` */
const HOUR_MERIDIEM_RE = /\b(\d{1,2})\s*([ap])\.?\s?m\.?\b/gi;

const DATE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
/** `10/03/2026`, `10.03.2026`, `10-03-26`. Separator must repeat. */
const DATE_NUM_RE = /\b(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})\b/g;
/** `10/03` — slash only. A bare `10.03` is far more likely to be a decimal. */
const DATE_SHORT_RE = /\b(\d{1,2})\/(\d{1,2})\b/g;

/**
 * Phone. Deliberately permissive on shape, strict on evidence: a match is only accepted
 * if it has 7–15 digits AND at least one of (leading `+`, parenthesised area code,
 * three or more separated groups).
 */
const PHONE_RE = /(?:\+\d{1,3}[\s.\-/]?)?(?:\(\d{1,5}\)[\s.\-/]?)?\d{2,5}(?:[\s.\-/]\d{2,5}){1,6}|\+\d{7,15}/g;

const CURRENCY_PREFIX_RE = /([$€£¥₹])\s?(\d[\d.,\u00a0\u202f ]{0,20}\d|\d)/g;
const CURRENCY_SUFFIX_RE =
  /(\d[\d.,\u00a0\u202f ]{0,20}\d|\d)\s?(€|£|\$|EUR|USD|GBP|CHF|Euros?|euros?|Dollars?|dollars?|Pfund|pounds?|livres?|sterline)\b/g;

const PERCENT_RE = /(\d[\d.,\u00a0\u202f ]{0,20}|\d)\s?%/g;

/** Longest-first alternation so `min` beats `m` and `km/h` beats `km`. */
const UNIT_RE =
  /(\d[\d.,\u00a0\u202f ]{0,20}|\d)\s?(km\/h|kWh|°C|°F|mbar|mm|cm|km|kg|mg|ml|MB|GB|TB|KB|min|sec|std|hrs?|m²|m³|m|g|l|h|s)\b/g;

const SYMBOL_RANGE_RE = /(\d[\d.,]{0,20}|\d)\s?[-–—]\s?(\d[\d.,]{0,20}|\d)/g;

/** `AB12-9C`, `X4R7Q`: uppercase, contains a digit and a letter, at least 4 chars. */
const IDENTIFIER_RE = /\b(?=[A-Z0-9]{0,20}\d)(?=[A-Z0-9]{0,20}[A-Z])[A-Z0-9]{4,20}(?:-[A-Z0-9]{2,20}){0,4}\b/g;
/** A bare run of 5+ digits is an ID, not a quantity. */
const LONG_DIGITS_RE = /\b\d{5,24}\b/g;

const ACRONYM_RE = /\b[A-Z]{2,6}\b/g;

function numberPattern(groupSeps: readonly string[], decimalSep: string): RegExp {
  const cls = groupSeps.map(escapeClass).join('');
  const dec = escapeClass(decimalSep);
  return new RegExp(
    `\\b\\d{1,3}(?:[${cls}]\\d{3})+(?:[${dec}]\\d+)?\\b|\\b\\d+(?:[${dec}]\\d+)?\\b`,
    'g',
  );
}

function escapeClass(s: string): string {
  return s.replace(/[\\\]^-]/g, '\\$&');
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Build the ordered rule list for a language.
 *
 * ORDER IS THE WHOLE DESIGN. Email before URL (an address contains a domain). Times and
 * dates before phone numbers (`10/03/2026` must not become a phone number). Currency
 * before percent before units before ranges before identifiers before plain numbers.
 * Acronyms last, so they never see letters we produced ourselves.
 */
export function buildRules(f: LocaleFormatter): readonly Rule[] {
  const numberRe = numberPattern(f.groupSeparators, f.decimalSeparator);
  const rangeWordRe =
    f.rangeWords.length > 0
      ? new RegExp(`(\\d[\\d.,]{0,20}|\\d)\\s(?:${f.rangeWords.join('|')})\\s(\\d[\\d.,]{0,20}|\\d)`, 'gi')
      : null;

  const rules: Rule[] = [];

  rules.push({
    kind: 'email',
    pattern: EMAIL_RE,
    render: (m, ctx) => {
      const [local, domain] = m[0].split('@');
      if (local === undefined || domain === undefined) return null;
      return f.email(local, domain, ctx);
    },
  });

  rules.push({
    kind: 'url',
    pattern: URL_RE,
    render: (m, ctx) => f.url(m[0], ctx),
  });

  if (f.extraRules) rules.push(...f.extraRules);

  rules.push({
    kind: 'time',
    pattern: TIME_RE,
    render: (m, ctx) => {
      const h = Number.parseInt(m[1] ?? '', 10);
      const min = Number.parseInt(m[2] ?? '', 10);
      if (!Number.isFinite(h) || h > 23) return null;
      const mer = m[4]?.toLowerCase() === 'a' ? 'am' : m[4]?.toLowerCase() === 'p' ? 'pm' : undefined;
      return f.time(h, min, mer, ctx);
    },
  });

  rules.push({
    kind: 'time',
    pattern: HOUR_MERIDIEM_RE,
    render: (m, ctx) => {
      const h = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(h) || h > 12) return null;
      return f.time(h, 0, m[2]?.toLowerCase() === 'a' ? 'am' : 'pm', ctx);
    },
  });

  rules.push({
    kind: 'date',
    pattern: DATE_ISO_RE,
    render: (m, ctx) => {
      const y = Number.parseInt(m[1] ?? '', 10);
      const mo = Number.parseInt(m[2] ?? '', 10);
      const d = Number.parseInt(m[3] ?? '', 10);
      return plausibleDate(d, mo, y) ? f.date(d, mo, y, ctx) : null;
    },
  });

  rules.push({
    kind: 'date',
    pattern: DATE_NUM_RE,
    render: (m, ctx) => {
      const a = Number.parseInt(m[1] ?? '', 10);
      const b = Number.parseInt(m[3] ?? '', 10);
      const y = expandYear(m[4] ?? '');
      // THE RULE (docs/03 3.1): field order comes from the context, never from the digits.
      // The one exception is a disambiguating value — a field > 12 can only be the day —
      // because reading "25 December" as "the 12th of month 25" is not a defensible output.
      let day = ctx.dateOrder === 'MDY' ? b : a;
      let month = ctx.dateOrder === 'MDY' ? a : b;
      if (month > 12 && day <= 12) {
        const t = day;
        day = month;
        month = t;
      }
      return plausibleDate(day, month, y) ? f.date(day, month, y, ctx) : null;
    },
  });

  rules.push({
    kind: 'date',
    pattern: DATE_SHORT_RE,
    render: (m, ctx) => {
      const a = Number.parseInt(m[1] ?? '', 10);
      const b = Number.parseInt(m[2] ?? '', 10);
      let day = ctx.dateOrder === 'MDY' ? b : a;
      let month = ctx.dateOrder === 'MDY' ? a : b;
      if (month > 12 && day <= 12) {
        const t = day;
        day = month;
        month = t;
      }
      return plausibleDate(day, month, undefined) ? f.date(day, month, undefined, ctx) : null;
    },
  });

  rules.push({
    kind: 'phone',
    pattern: PHONE_RE,
    render: (m, ctx) => {
      const raw = m[0];
      const digits = digitsOnly(raw);
      if (digits.length < 7 || digits.length > 15) return null;
      const separators = (raw.match(/[\s.\-/]/g) ?? []).length;
      const evidence = raw.startsWith('+') || raw.includes('(') || separators >= 2;
      if (!evidence) return null;
      return f.phone(digits, raw.trimStart().startsWith('+'), ctx);
    },
  });

  rules.push({
    kind: 'currency',
    pattern: CURRENCY_PREFIX_RE,
    render: (m, ctx) => {
      const code = symbolToCode(m[1] ?? '', ctx.currency);
      const { int, frac } = splitAmount(m[2] ?? '', f.groupSeparators, f.decimalSeparator);
      return f.currency(int, frac, code, ctx);
    },
  });

  rules.push({
    kind: 'currency',
    pattern: CURRENCY_SUFFIX_RE,
    render: (m, ctx) => {
      const code = symbolToCode(m[2] ?? '', ctx.currency);
      const { int, frac } = splitAmount(m[1] ?? '', f.groupSeparators, f.decimalSeparator);
      return f.currency(int, frac, code, ctx);
    },
  });

  rules.push({
    kind: 'percent',
    pattern: PERCENT_RE,
    render: (m, ctx) => f.percent(m[1] ?? '', ctx),
  });

  rules.push({
    kind: 'unit',
    pattern: UNIT_RE,
    render: (m, ctx) => f.unit(m[1] ?? '', m[2] ?? '', ctx),
  });

  if (rangeWordRe) {
    rules.push({
      kind: 'range',
      pattern: rangeWordRe,
      render: (m, ctx) => f.range(m[1] ?? '', m[2] ?? '', ctx),
    });
  }

  rules.push({
    kind: 'range',
    pattern: SYMBOL_RANGE_RE,
    render: (m, ctx) => f.range(m[1] ?? '', m[2] ?? '', ctx),
  });

  rules.push({
    kind: 'digit-group',
    pattern: IDENTIFIER_RE,
    render: (m, ctx) => f.identifier(m[0], ctx),
  });

  rules.push({
    kind: 'digit-group',
    pattern: LONG_DIGITS_RE,
    render: (m, ctx) => f.identifier(m[0], ctx),
  });

  rules.push({
    kind: 'number',
    pattern: numberRe,
    render: (m, ctx) => {
      const { int, frac } = splitAmount(m[0], f.groupSeparators, f.decimalSeparator);
      if (int.length === 0 && frac.length === 0) return null;
      if (frac.length > 0) return f.decimal(int, frac, ctx);
      const n = Number.parseInt(int, 10);
      if (!Number.isFinite(n)) return null;
      return f.cardinal(n, ctx);
    },
  });

  if (f.lateRules) rules.push(...f.lateRules);

  rules.push({
    kind: 'acronym',
    pattern: ACRONYM_RE,
    render: (m, ctx) => f.acronym(m[0], ctx),
  });

  return rules;
}

const SYMBOL_CODES: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
};

function symbolToCode(sym: string, fallback: string): string {
  const s = sym.trim();
  const direct = SYMBOL_CODES[s];
  if (direct !== undefined) return direct;
  const upper = s.toUpperCase();
  if (/^(EUR|USD|GBP|CHF)$/.test(upper)) return upper;
  if (/^EUROS?$/.test(upper)) return 'EUR';
  if (/^DOLLARS?$/.test(upper)) return 'USD';
  if (/^(POUNDS?|PFUND|LIVRES?|STERLINE)$/.test(upper)) return 'GBP';
  return fallback;
}

// ---------------------------------------------------------------------------
// Shared acronym policy
// ---------------------------------------------------------------------------

/**
 * Acronyms that are read as words rather than spelled (docs/03 3.3). Tenants override
 * per acronym via `ctx.acronyms`; this is only the default. Kept short on purpose —
 * spelling out is the safe default, and a wrong "word" reading is worse than a spelled one.
 */
export const READ_AS_WORD = new Set([
  'NASA',
  'NATO',
  'UNESCO',
  'UNICEF',
  'OPEC',
  'RAM',
  'ROM',
  'PIN',
  'SIM',
  'LASER',
  'RADAR',
  'SCUBA',
  'AIDS',
  'ISO',
  'IKEA',
  'SEPA',
  'IBAN',
  'BIC',
]);

/** Never touched: these are ordinary words that happen to be shouted. */
export const NOT_AN_ACRONYM = new Set(['OK', 'TV', 'ID', 'PC', 'AM', 'PM', 'A', 'I']);

/**
 * Default acronym handling. `letterGap` is the separator used between spelled letters —
 * a hyphen or a thin space both work; a plain space is safest across TTS vendors, but a
 * comma over-pauses. We use a narrow no-break space.
 */
export function defaultAcronym(token: string, ctx: NormalizationContext, letterGap = ' '): string | null {
  const override = ctx.acronyms[token];
  if (override === 'word') return token;
  if (override !== undefined && override !== 'spell') return override;
  if (override === undefined) {
    if (NOT_AN_ACRONYM.has(token)) return null;
    if (READ_AS_WORD.has(token)) return token;
  }
  return token.split('').join(letterGap);
}
