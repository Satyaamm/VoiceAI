/**
 * Chain of Responsibility.
 *
 * Used for the guardrail pipeline (docs/03-problem-coverage.md §E) and for
 * pre-dispatch compliance checks (§K). Each handler may pass, rewrite, or halt.
 *
 * Guardrails run on the LLM token stream with a ~15ms budget, so the chain is
 * ordered cheapest-first and short-circuits on the first BLOCK.
 */

export type ChainOutcome<T> =
  | { readonly action: 'pass' }
  | { readonly action: 'rewrite'; readonly value: T; readonly reason: string }
  | { readonly action: 'block'; readonly replacement: T; readonly reason: string }
  | { readonly action: 'escalate'; readonly reason: string };

export interface ChainHandler<T, TCtx> {
  readonly key: string;
  readonly label: string;
  /** Budget hint in ms — the chain warns when a handler exceeds it. */
  readonly budgetMs: number;
  handle(value: T, ctx: TCtx): ChainOutcome<T> | Promise<ChainOutcome<T>>;
}

export interface ChainResult<T> {
  readonly value: T;
  readonly blocked: boolean;
  readonly escalated: boolean;
  /** Every handler that did something — surfaced in the trace viewer. */
  readonly applied: Array<{ key: string; action: string; reason: string; durationMs: number }>;
  readonly totalMs: number;
}

export class HandlerChain<T, TCtx> {
  private readonly handlers: Array<ChainHandler<T, TCtx>> = [];

  constructor(
    readonly name: string,
    private readonly onBudgetExceeded?: (key: string, ms: number, budget: number) => void,
  ) {}

  use(handler: ChainHandler<T, TCtx>): this {
    this.handlers.push(handler);
    return this;
  }

  async run(initial: T, ctx: TCtx): Promise<ChainResult<T>> {
    const applied: ChainResult<T>['applied'] = [];
    const startedAt = performance.now();
    let value = initial;

    for (const handler of this.handlers) {
      const t0 = performance.now();
      const outcome = await handler.handle(value, ctx);
      const durationMs = performance.now() - t0;

      if (durationMs > handler.budgetMs) {
        this.onBudgetExceeded?.(handler.key, durationMs, handler.budgetMs);
      }

      if (outcome.action === 'pass') continue;

      applied.push({
        key: handler.key,
        action: outcome.action,
        reason: 'reason' in outcome ? outcome.reason : '',
        durationMs,
      });

      if (outcome.action === 'rewrite') {
        value = outcome.value;
        continue;
      }
      if (outcome.action === 'block') {
        return {
          value: outcome.replacement,
          blocked: true,
          escalated: false,
          applied,
          totalMs: performance.now() - startedAt,
        };
      }
      // escalate — hand to a human, stop processing
      return {
        value,
        blocked: false,
        escalated: true,
        applied,
        totalMs: performance.now() - startedAt,
      };
    }

    return {
      value,
      blocked: false,
      escalated: false,
      applied,
      totalMs: performance.now() - startedAt,
    };
  }

  keys(): string[] {
    return this.handlers.map((h) => h.key);
  }
}
