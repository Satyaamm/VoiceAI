/**
 * PII / PHI detection and redaction.
 *
 * docs/14 §1: this runs BEFORE the LLM, not only before storage. Sending a
 * transcript to a model vendor is a disclosure to a sub-processor in whatever
 * country it runs — GDPR Art. 5(1)(c) data minimisation and Art. 44 transfer rules
 * both apply, and under HIPAA it's a PHI disclosure requiring a BAA.
 *
 * Two distinct modes, and conflating them is a bug:
 *
 *   REDACT  — irreversible. For storage, logs, and analytics.
 *   MASK    — display-time only, for users lacking `call:read_pii`. The underlying
 *             data is untouched; this is an access-control view.
 *
 * TOKENISE is a third mode used on the LLM path: replace the value with a stable
 * placeholder so the model can still reason about it ("confirm the last four of
 * {{CARD_1}}") without ever receiving the value.
 *
 * ⚠️ Regex detection is a floor, not a ceiling. It catches structured identifiers
 * reliably and free-text names poorly. For HIPAA workloads pair this with a trained
 * NER model — noted as a Phase 2 requirement in docs/14.
 */

export type PiiKind =
  | 'card'
  | 'ssn'
  | 'email'
  | 'phone'
  | 'iban'
  | 'ip'
  | 'dob'
  | 'postcode_uk'
  | 'nhs_number'
  | 'passport'
  | 'long_digit_sequence';

export interface PiiMatch {
  kind: PiiKind;
  start: number;
  end: number;
  value: string;
}

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  /** Extra validation to cut false positives (e.g. Luhn for cards). */
  validate?: (value: string) => boolean;
}

/** Luhn check — turns "any 16 digits" into "a plausible card number". */
function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { kind: 'card', pattern: /\b(?:\d[ -]*?){13,19}\b/g, validate: luhn },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  // E.164 and common national formats. Deliberately conservative.
  { kind: 'phone', pattern: /\+?\d[\d\s().-]{7,17}\d/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: 'dob', pattern: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g },
  { kind: 'postcode_uk', pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi },
  { kind: 'nhs_number', pattern: /\b\d{3}\s?\d{3}\s?\d{4}\b/g },
  { kind: 'passport', pattern: /\b[A-Z]{1,2}\d{6,9}\b/g },
  // Catch-all for spoken IDs: "four two seven three..." arrives as digits.
  { kind: 'long_digit_sequence', pattern: /\b\d{6,}\b/g },
];

export function detect(text: string, kinds?: PiiKind[]): PiiMatch[] {
  const active = kinds ? DETECTORS.filter((d) => kinds.includes(d.kind)) : DETECTORS;
  const matches: PiiMatch[] = [];

  for (const detector of active) {
    const re = new RegExp(detector.pattern.source, detector.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (detector.validate && !detector.validate(value)) continue;
      matches.push({ kind: detector.kind, start: m.index, end: m.index + value.length, value });
      if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard
    }
  }

  // Overlaps are resolved by preferring the longer, more specific match — a card
  // number must not be reported as a generic digit sequence.
  return dedupeOverlaps(matches);
}

function dedupeOverlaps(matches: PiiMatch[]): PiiMatch[] {
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const out: PiiMatch[] = [];
  let cursor = -1;
  for (const m of sorted) {
    if (m.start >= cursor) {
      out.push(m);
      cursor = m.end;
    }
  }
  return out;
}

/** Irreversible. For storage, logs, analytics. */
export function redact(text: string, kinds?: PiiKind[]): { text: string; found: PiiKind[] } {
  const matches = detect(text, kinds);
  return { text: applyReplacements(text, matches, (m) => `[${m.kind.toUpperCase()}]`), found: [...new Set(matches.map((m) => m.kind))] };
}

/**
 * Display-time masking for users without `call:read_pii`.
 *
 * Leaves the last 4 characters of structured identifiers visible, because "is this
 * the right order number?" is answerable from the tail alone — the minimum-necessary
 * principle (HIPAA §164.308(a)(4)) rather than blanket hiding.
 */
export function mask(text: string, kinds?: PiiKind[]): string {
  const matches = detect(text, kinds);
  return applyReplacements(text, matches, (m) => {
    if (m.kind === 'email') {
      const [user = '', domain = ''] = m.value.split('@');
      return `${user.slice(0, 1)}${'•'.repeat(Math.max(3, user.length - 1))}@${domain}`;
    }
    const tail = m.value.replace(/\D/g, '').slice(-4);
    return tail.length === 4 ? `${'•'.repeat(6)}${tail}` : '•'.repeat(8);
  });
}

/**
 * Replace PII with stable placeholders for the LLM path.
 *
 * The model can reason about the value's role without receiving it, and the
 * orchestrator can substitute real values back into tool calls. This is how you
 * keep a card number out of a vendor's logs while still letting the agent say
 * "I've got the card ending 4242".
 */
export function tokenise(
  text: string,
  kinds?: PiiKind[],
): { text: string; vault: Map<string, string> } {
  const matches = detect(text, kinds);
  const vault = new Map<string, string>();
  const counters = new Map<PiiKind, number>();

  const output = applyReplacements(text, matches, (m) => {
    const n = (counters.get(m.kind) ?? 0) + 1;
    counters.set(m.kind, n);
    const token = `{{${m.kind.toUpperCase()}_${n}}}`;
    vault.set(token, m.value);
    return token;
  });

  return { text: output, vault };
}

/** Reverse tokenisation — used when populating a tool call with real values. */
export function detokenise(text: string, vault: Map<string, string>): string {
  let out = text;
  for (const [token, value] of vault) out = out.split(token).join(value);
  return out;
}

function applyReplacements(
  text: string,
  matches: PiiMatch[],
  replacer: (m: PiiMatch) => string,
): string {
  if (!matches.length) return text;
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const m of ordered) {
    out += text.slice(cursor, m.start) + replacer(m);
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

/**
 * Streaming redactor for the live token path.
 *
 * The LLM emits tokens one at a time, but PII spans token boundaries — you cannot
 * decide whether "4242" is a card fragment until you've seen what follows. This
 * holds back a small tail buffer and only releases text that can no longer become
 * part of a match. Budget: well under the 15ms guardrail allowance in docs/03 §E.
 */
export class StreamingRedactor {
  private buffer = '';
  /** Longest plausible match; must exceed the widest detector window. */
  private readonly holdback = 24;

  constructor(private readonly kinds?: PiiKind[]) {}

  /** Feed a token; returns text that is safe to emit now. */
  push(chunk: string): string {
    this.buffer += chunk;
    if (this.buffer.length <= this.holdback) return '';
    const releasable = this.buffer.slice(0, this.buffer.length - this.holdback);
    // Only release at a whitespace boundary so a match can't be split mid-token.
    const cut = releasable.lastIndexOf(' ');
    if (cut < 0) return '';
    const emit = this.buffer.slice(0, cut + 1);
    this.buffer = this.buffer.slice(cut + 1);
    return redact(emit, this.kinds).text;
  }

  /** Flush the tail at end of stream. */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return redact(remaining, this.kinds).text;
  }
}
