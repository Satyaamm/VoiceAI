/**
 * Stage 1 — sanitize. Language INDEPENDENT.
 *
 * docs/03 3.5: "Reads markdown/JSON artifacts aloud ('asterisk asterisk')". This is the
 * single most embarrassing and most common failure in shipped voice agents, and it is
 * entirely preventable. An LLM told to be conversational still emits `**Total:** $12`,
 * bullet lists, `\n\n`, the occasional stray `{"status":"ok"}` from a leaked tool result,
 * and emoji.
 *
 * Design rules:
 *  - Every pattern is anchored and bounded. No nested quantifiers, no catastrophic
 *    backtracking: this runs on the hot path at clause granularity.
 *  - We UNWRAP emphasis rather than delete it (`**Total**` -> `Total`), but DELETE
 *    structure (fences, headers, bullets, table pipes) and decoration (emoji).
 *  - Parentheses are NOT stripped wholesale — `(and that includes VAT)` is real speech.
 *    Only bracketed spans and cue-matching parentheticals go.
 */

import type { NormalizationContext, Normalizer, TransformKind, TransformSink } from './types.js';

interface SanitizeRule {
  readonly kind: TransformKind;
  readonly pattern: RegExp;
  /** `$1`-style replacement, or a function. */
  readonly to: string | ((...args: string[]) => string);
}

/**
 * Stage-direction cues. An LLM asked for warmth will emit `*smiles*`, `[laughs]`,
 * `(pauses)`. Deliberately multilingual and deliberately short — a false negative just
 * leaves a word in; a false positive deletes real content, which is worse.
 */
const STAGE_CUE =
  /^(?:[a-zäöüßàâçéèêëîïôûùüÿñæœáíóúõ' -]{2,40})?(?:laugh|chuckl|smil|sigh|pause|whisper|clear(?:s|ing)? throat|beat|softly|warmly|gently|nods?|音|lacht|lächelt|seufzt|räuspert|pause|rit|sourit|soupire|silence|ríe|sonríe|suspira|ride|sorride|sospira|lacht|glimlacht|zucht)(?:s|es|ed|ing|t|e)?(?:[a-zäöüßàâçéèêëîïôûùüÿñæœáíóúõ' -]{0,20})$/i;

/**
 * Emoji + pictographs + variation selectors + ZWJ + skin tones + regional indicators.
 * Built from explicit ranges rather than \p{Emoji} because \p{Emoji} matches ASCII
 * digits and `#`/`*`, which would be a disaster here.
 */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

const RULES: readonly SanitizeRule[] = [
  // --- fenced code: delete outright. Nobody wants a shell script read aloud. -------
  { kind: 'code', pattern: /```[\s\S]{0,4000}?```/g, to: ' ' },
  // An unterminated fence (streaming clause split mid-block): drop the opener + lang tag.
  { kind: 'code', pattern: /```[a-zA-Z0-9_+-]{0,20}\n?/g, to: ' ' },
  // Inline code: keep the content, lose the backticks.
  { kind: 'code', pattern: /`{1,2}([^`\n]{1,200})`{1,2}/g, to: '$1' },

  // --- HTML / XML / SSML artifacts -------------------------------------------------
  // Conservative: bounded tag body, no newlines. Real speech rarely contains `<...>`.
  { kind: 'html', pattern: /<\/?[a-zA-Z][a-zA-Z0-9-]{0,40}(?:\s[^<>\n]{0,200})?\/?>/g, to: ' ' },
  { kind: 'html', pattern: /&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, to: (m) => HTML_ENTITIES[m] ?? ' ' },

  // --- JSON / tool-result leakage --------------------------------------------------
  // Escaped newlines and quotes that arrived as literal backslash sequences.
  { kind: 'json-artifact', pattern: /\\[nrt]/g, to: ' ' },
  { kind: 'json-artifact', pattern: /\\"/g, to: '"' },
  // `"status": ` style keys — the value is usually the human-readable part.
  { kind: 'json-artifact', pattern: /"([a-zA-Z_][\w.-]{0,40})"\s*:\s*/g, to: ' ' },
  // Braces/brackets left over once the keys are gone.
  { kind: 'json-artifact', pattern: /[{}]/g, to: ' ' },

  // --- markdown structure ----------------------------------------------------------
  { kind: 'markdown', pattern: /^[ \t]{0,8}#{1,6}[ \t]+/gm, to: '' }, // ATX headers
  { kind: 'markdown', pattern: /^[ \t]{0,8}>[ \t]?/gm, to: '' }, // blockquote
  { kind: 'markdown', pattern: /^[ \t]{0,8}([*\-_])(?:[ \t]{0,3}\1){2,}[ \t]*$/gm, to: '' }, // hr
  { kind: 'markdown', pattern: /^[ \t]{0,8}[-*+•·][ \t]+/gm, to: '' }, // bullets
  { kind: 'markdown', pattern: /^[ \t]{0,8}\d{1,3}[.)][ \t]+/gm, to: '' }, // ordered list markers
  { kind: 'markdown', pattern: /^[ \t]{0,8}\|[ \t]?|[ \t]?\|[ \t]{0,8}$/gm, to: '' }, // table edges
  { kind: 'markdown', pattern: /^[ \t]{0,8}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*){0,20}\|?[ \t]*$/gm, to: '' }, // table rule
  { kind: 'markdown', pattern: /[ \t]?\|[ \t]?/g, to: ', ' }, // remaining cell separators

  // --- markdown inline -------------------------------------------------------------
  { kind: 'markdown', pattern: /!\[([^\]\n]{0,200})\]\([^)\n]{0,500}\)/g, to: '$1' }, // image
  { kind: 'markdown', pattern: /\[([^\]\n]{1,200})\]\([^)\n]{0,500}\)/g, to: '$1' }, // link: keep the label
  { kind: 'markdown', pattern: /\*\*\*([^*\n]{1,300})\*\*\*/g, to: '$1' },
  { kind: 'markdown', pattern: /\*\*([^*\n]{1,300})\*\*/g, to: '$1' },
  { kind: 'markdown', pattern: /___([^_\n]{1,300})___/g, to: '$1' },
  { kind: 'markdown', pattern: /__([^_\n]{1,300})__/g, to: '$1' },
  { kind: 'markdown', pattern: /~~([^~\n]{1,300})~~/g, to: '$1' },
  // Single-underscore italics only between non-word chars, so snake_case survives.
  { kind: 'markdown', pattern: /(^|[^\w])_([^_\n]{1,300})_(?=$|[^\w])/g, to: '$1$2' },
];

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * `*sighs*` / `*taps keyboard*` — asterisk-wrapped stage direction. Deleted when the
 * content reads like a cue, otherwise unwrapped as ordinary emphasis.
 */
const ASTERISK_SPAN = /\*([^*\n]{1,80})\*/g;
/** `[…]` always goes: markdown leftovers and stage directions both live there. */
const BRACKET_SPAN = /\[([^\]\n]{0,120})\]/g;
/** `(…)` only goes when it reads like a cue. */
const PAREN_SPAN = /\(([^()\n]{1,80})\)/g;

function stripSpans(text: string, sink: TransformSink): string {
  let out = text;

  out = out.replace(ASTERISK_SPAN, (m, inner: string) => {
    const drop = STAGE_CUE.test(inner.trim());
    sink({ stage: 'sanitize', kind: drop ? 'stage-direction' : 'markdown', source: m, output: drop ? '' : inner });
    return drop ? ' ' : inner;
  });

  out = out.replace(BRACKET_SPAN, (m, inner: string) => {
    sink({ stage: 'sanitize', kind: 'stage-direction', source: m, output: '' });
    return ' ';
  });

  out = out.replace(PAREN_SPAN, (m, inner: string) => {
    if (!STAGE_CUE.test(inner.trim())) return m;
    sink({ stage: 'sanitize', kind: 'stage-direction', source: m, output: '' });
    return ' ';
  });

  return out;
}

/**
 * Collapse whitespace. Newlines become sentence-ish boundaries rather than vanishing,
 * because a list of three items should not run together into one breathless clause.
 */
function collapse(text: string, sink: TransformSink): string {
  const before = text;
  const out = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*(?=[,.;:])/g, '')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/\.\s*,\s*/g, '. ')
    .replace(/^[\s,;:.]+/, '')
    .replace(/\s+$/, '');
  if (out !== before) sink({ stage: 'sanitize', kind: 'whitespace', source: before, output: out });
  return out;
}

/**
 * Language-independent stage 1.
 *
 * Idempotent: running it twice yields the same string, which matters because the
 * streaming path may re-sanitize a carried-over fragment.
 */
export function sanitize(text: string, _ctx: NormalizationContext, sink: TransformSink): string {
  let out = text;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const next =
      typeof rule.to === 'string'
        ? out.replace(rule.pattern, rule.to)
        : out.replace(rule.pattern, rule.to as (substring: string, ...a: string[]) => string);
    if (next !== out) {
      sink({ stage: 'sanitize', kind: rule.kind, source: out, output: next });
      out = next;
    }
  }

  out = stripSpans(out, sink);

  EMOJI.lastIndex = 0;
  if (EMOJI.test(out)) {
    EMOJI.lastIndex = 0;
    const next = out.replace(EMOJI, ' ');
    sink({ stage: 'sanitize', kind: 'emoji', source: out, output: next });
    out = next;
  }

  return collapse(out, sink);
}

export const sanitizer: Normalizer = {
  name: 'sanitize',
  run: sanitize,
};
