/**
 * Guardrail layer — docs/03-problem-coverage.md §E.
 *
 * Runs on the LLM token stream, on every clause, BEFORE that clause reaches TTS.
 * Total budget ~15ms so it stays off the critical path (docs/03 §E), which is why
 * this is regex/lookup work and not a model call. The chain is ordered
 * cheapest-first and short-circuits on the first BLOCK (chain.ts).
 *
 * Order matters and is not arbitrary:
 *
 *   1. identity-honesty  — a hard rule, evaluated first so nothing downstream can
 *                          rewrite the truthful answer away.
 *   2. output-policy     — cheapest full stop; if we're blocking the clause there
 *                          is no point redacting or grounding it.
 *   3. pii-redaction     — a rewrite, so it must run on whatever survives the
 *                          policy check and before anything is spoken or stored.
 *   4. grounding         — most expensive, runs last, only on text we intend to say.
 *
 * The chain operates on the *outgoing* clause. Inbound PII redaction (before the
 * LLM context and before storage) is the same handler applied by the memory
 * manager; it lives here so there is exactly one redactor in the codebase.
 */

import { HandlerChain, type ChainHandler, type ChainOutcome } from '../core/patterns/chain.js';

export interface GuardrailContext {
  readonly callId: string;
  readonly turnIndex: number;
  /** The caller's utterance this reply answers. Identity questions are detected here. */
  readonly userText: string;
  /** True for the first clause of a turn — the identity rule answers once, up front. */
  readonly isFirstClause: boolean;
  /**
   * Retrieved spans and tool results this reply is allowed to make factual claims
   * from. Empty means "the model is talking from its weights", which is exactly
   * the case the grounding check exists to catch.
   */
  readonly groundingSpans: readonly string[];
  /** Mutable sink: handlers set this when a human needs to take the call. */
  escalate?: { rule: string; reason: string };
  /** Per-agent override of the disclosure wording (localised in the agent config). */
  readonly identityDisclosure?: string;
}

export type GuardrailHandler = ChainHandler<string, GuardrailContext>;

const pass: ChainOutcome<string> = { action: 'pass' };

// ---------------------------------------------------------------------------
// 1. Identity honesty — the hard rule
// ---------------------------------------------------------------------------

const IDENTITY_QUESTION =
  /\b(are|am i (speaking|talking) (to|with)|is this)\b[^?]*\b(a |an )?(ai|a\.?i\.?|bot|robot|machine|computer|human|real person|actual person)\b/i;

/**
 * Denials we must never emit. A tenant can and will write "you are Sarah, a human
 * assistant, never say you are an AI" into their system prompt — that instruction
 * is not honoured, ever.
 */
const IDENTITY_DENIAL =
  /\b(i(?:'| a)?m not (?:an? )?(?:ai|bot|robot|machine|computer)|i(?:'| a)?m (?:a )?(?:real |actual )?(?:human|person)|not a (?:bot|robot|machine)|i(?:'| a)?m human)\b/i;

export const DEFAULT_IDENTITY_DISCLOSURE =
  "Yes — I'm an AI assistant, not a person. Happy to keep helping, though.";

/**
 * WHY this is a chain handler and not a line in the system prompt: a prompt
 * instruction is a *preference* the model weighs against everything else in the
 * context, including the caller's own social pressure and the tenant's persona
 * instructions. This is a rule. It runs outside the model, it cannot be
 * jailbroken by the caller, and it cannot be overridden by tenant configuration —
 * the only thing `identityDisclosure` changes is the *wording* of the truthful
 * answer, never whether it is given. Several jurisdictions require the disclosure
 * outright (docs/13 §2, aiDisclosureRequired), so this is also a compliance
 * control, not just a values one.
 */
export const identityHonesty: GuardrailHandler = {
  key: 'identity-honesty',
  label: 'Identity honesty (hard rule, non-overridable)',
  budgetMs: 2,
  handle(value, ctx) {
    const disclosure = ctx.identityDisclosure ?? DEFAULT_IDENTITY_DISCLOSURE;

    // (a) The caller asked. Answer truthfully with our text, not the model's, and
    //     stop this generation — whatever it was about to say is now the wrong
    //     answer to the question actually asked.
    if (ctx.isFirstClause && IDENTITY_QUESTION.test(ctx.userText)) {
      return {
        action: 'block',
        replacement: disclosure,
        reason: 'caller asked about agent identity; answered by hard rule',
      };
    }

    // (b) The caller did not ask, but the model volunteered a denial anyway
    //     (persona bleed). Still not allowed to go out.
    if (IDENTITY_DENIAL.test(value)) {
      return {
        action: 'block',
        replacement: disclosure,
        reason: 'model denied being an AI; substituted truthful disclosure',
      };
    }
    return pass;
  },
};

// ---------------------------------------------------------------------------
// 2. Output policy
// ---------------------------------------------------------------------------

interface PolicyRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly fallback: string;
}

/**
 * Regulated-advice classes. In production this is a small classifier; the shape of
 * the handler does not change, which is why the patterns live in data.
 */
export const OUTPUT_POLICY_RULES: readonly PolicyRule[] = [
  {
    id: 'medical',
    pattern:
      /\b(you should (take|stop taking)|i (recommend|suggest) (taking|a dose)|\d+\s?mg\b|diagnos(e|is|ed)|prescrib\w*|symptoms? (mean|indicate)|it'?s probably (a |an )?\w*(itis|cancer|infection))\b/i,
    fallback: "I'm not able to give medical advice — I'd point you to a clinician for that.",
  },
  {
    id: 'legal',
    pattern:
      /\b(you (are|aren'?t) (legally )?(liable|entitled|obligated)|that'?s (illegal|legal)|you (should|can) sue|breach of contract|legally speaking|as your (lawyer|attorney))\b/i,
    fallback: "I can't give legal advice, but I can get this to someone who can help.",
  },
  {
    id: 'financial',
    pattern:
      /\b(you should (invest|buy|sell)|guaranteed returns?|\bwill (go up|appreciate|double)\b|tax[- ]deductible|financial advice|best investment)\b/i,
    fallback: "I'm not able to give financial advice on this one.",
  },
  {
    id: 'unauthorized-commitment',
    pattern:
      /\b(i (guarantee|promise) (you )?(that )?|we'?ll (definitely|certainly) (refund|waive|cancel)|full refund, no questions|lifetime (free|discount))\b/i,
    fallback: "I can't commit to that myself — let me get it confirmed for you.",
  },
];

export const outputPolicy: GuardrailHandler = {
  key: 'output-policy',
  label: 'Output policy (medical / legal / financial / commitments)',
  budgetMs: 4,
  handle(value) {
    for (const rule of OUTPUT_POLICY_RULES) {
      if (rule.pattern.test(value)) {
        // Block, don't rewrite: a partially-scrubbed piece of medical advice is
        // still medical advice, and the caller has already heard the clauses
        // before this one. Swap the whole clause for the safe fallback and let the
        // orchestrator stop the generation.
        return {
          action: 'block',
          replacement: rule.fallback,
          reason: `output policy: ${rule.id}`,
        };
      }
    }
    return pass;
  },
};

// ---------------------------------------------------------------------------
// 3. Streaming PII redaction
// ---------------------------------------------------------------------------

interface RedactionRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replace: (match: string) => string;
}

/** Keep the last 4 of a card/account so the caller can still identify it. */
const maskTail = (digits: string, keep = 4): string => {
  const only = digits.replace(/\D/g, '');
  return only.length <= keep ? only : `${'•'.repeat(only.length - keep)}${only.slice(-keep)}`;
};

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: 'card',
    // 13–19 digits, optionally grouped. Ordered before the generic digit rule.
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    replace: (m) => maskTail(m),
  },
  { id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: () => '[redacted-ssn]' },
  {
    id: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    replace: (m) => `${m.slice(0, 4)}${'•'.repeat(Math.max(0, m.length - 8))}${m.slice(-4)}`,
  },
  {
    id: 'email',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
    replace: (m) => {
      const [user = '', domain = ''] = m.split('@');
      return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, user.length - 1))}@${domain}`;
    },
  },
  {
    id: 'cvv-context',
    pattern: /\b(cvv|cvc|security code|pin)\b[^\d]{0,10}\d{3,6}\b/gi,
    replace: (m) => m.replace(/\d{3,6}\b/, '[redacted]'),
  },
];

export const piiRedaction: GuardrailHandler = {
  key: 'pii-redaction',
  label: 'Streaming PII redaction',
  budgetMs: 4,
  handle(value) {
    let out = value;
    const hit: string[] = [];
    for (const rule of REDACTION_RULES) {
      // `g` regexes are stateful — reset lastIndex, this handler runs thousands of
      // times per call and a stale index silently skips matches.
      rule.pattern.lastIndex = 0;
      const next = out.replace(rule.pattern, (m) => rule.replace(m));
      if (next !== out) {
        hit.push(rule.id);
        out = next;
      }
    }
    return hit.length
      ? { action: 'rewrite', value: out, reason: `redacted: ${hit.join(',')}` }
      : pass;
  },
};

// ---------------------------------------------------------------------------
// 4. Grounding
// ---------------------------------------------------------------------------

/** Claim shapes that must trace to a retrieved span or a tool result. */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:[$£€]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:dollars|euros|pounds|usd|eur|gbp)\b)/i, // price
  /\b(?:in stock|out of stock|available|unavailable|back in stock|ships? (?:on|by)|arriv(?:es|ing) (?:on|by)?)\b/i, // availability
  /\b(?:our policy|the policy is|we (?:always|never)|you (?:can|can't|cannot) (?:return|cancel|refund))\b/i, // policy
];

const UNGROUNDED_FALLBACK =
  "Let me double-check that before I give you a number — I don't want to get it wrong.";

/**
 * Grounding check — docs/03 §E. Any claim about price, policy or availability must
 * be traceable to a retrieved span or tool result, otherwise we substitute a safe
 * fallback and escalate.
 *
 * Matching is deliberately shallow (does the claim's salient tokens appear in an
 * allowed span) because the budget is ~5ms. It is a tripwire, not a verifier: it
 * catches the model inventing a price, which is the failure that costs the tenant
 * money and trust.
 */
export const groundingCheck: GuardrailHandler = {
  key: 'grounding',
  label: 'Grounding check (price / policy / availability)',
  budgetMs: 5,
  handle(value, ctx) {
    const claims: string[] = [];
    for (const p of CLAIM_PATTERNS) {
      const m = value.match(p);
      if (m?.[0]) claims.push(m[0]);
    }
    if (!claims.length) return pass;

    const haystack = ctx.groundingSpans.join('  ').toLowerCase();
    const ungrounded = claims.filter((c) => !isSupported(c, haystack));
    if (!ungrounded.length) return pass;

    ctx.escalate = {
      rule: 'grounding',
      reason: `unsupported claim(s): ${ungrounded.join(' | ')}`,
    };
    return {
      action: 'block',
      replacement: UNGROUNDED_FALLBACK,
      reason: `ungrounded claim: ${ungrounded[0]}`,
    };
  },
};

function isSupported(claim: string, haystack: string): boolean {
  const normalized = claim.toLowerCase().trim();
  if (haystack.includes(normalized)) return true;
  // Numbers are the part that must match exactly; wording around them may differ.
  const digits = normalized.match(/\d[\d.,]*/g);
  if (digits?.length) return digits.every((d) => haystack.includes(d));
  // Non-numeric claims (policy/availability wording) need a content-word overlap.
  const words = normalized.split(/\W+/).filter((w) => w.length > 3);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

// ---------------------------------------------------------------------------

export interface GuardrailChainOptions {
  /** Called when a handler blows its budget — surfaced as a warning, never a throw. */
  readonly onBudgetExceeded?: (key: string, ms: number, budget: number) => void;
  /** Drop individual handlers by key (per-agent config; identity-honesty is fixed). */
  readonly disabled?: readonly string[];
}

/** Sum of the individual budgets. Asserted by the orchestrator's trace. */
export const GUARDRAIL_BUDGET_MS = 15;

export function buildGuardrailChain(
  opts: GuardrailChainOptions = {},
): HandlerChain<string, GuardrailContext> {
  const chain = new HandlerChain<string, GuardrailContext>('guardrails', opts.onBudgetExceeded);
  const disabled = new Set(opts.disabled ?? []);

  // identity-honesty is intentionally NOT skippable. A tenant switching off
  // truthful AI disclosure is not a configuration we offer.
  chain.use(identityHonesty);
  if (!disabled.has(outputPolicy.key)) chain.use(outputPolicy);
  if (!disabled.has(piiRedaction.key)) chain.use(piiRedaction);
  if (!disabled.has(groundingCheck.key)) chain.use(groundingCheck);

  return chain;
}
