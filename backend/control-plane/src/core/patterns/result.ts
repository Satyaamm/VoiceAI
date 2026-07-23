/**
 * Result — explicit success/failure without exceptions.
 *
 * The turn loop has a hard latency budget; thrown exceptions cost stack unwinding
 * and, worse, hide failure modes from the type system. Every fallible operation on
 * the hot path returns a Result so the caller is forced to handle degradation.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/** Unwrap or fall back to a default. Never throws. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Map the success channel, leaving errors untouched. */
export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? Ok(fn(r.value)) : r;
}

/** Wrap a throwing async fn into a Result. Use at adapter boundaries only. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return Ok(await fn());
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}
