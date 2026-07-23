/**
 * Cross-cutting HTTP middleware.
 *
 * Kept out of the version folders deliberately: authentication, error mapping and
 * request context are platform concerns, not API-version concerns. When v2 lands
 * it reuses these unchanged — only the route surface is versioned.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { ZodError } from 'zod';

import type { Container } from '../../container.js';
import {
  AuthorizationError,
  authorize,
  type Principal,
  type TenantScope,
} from '../../domain/tenant.js';
import { ConflictError, NotFoundError } from '../../repositories/types.js';

/** Request-scoped variables, populated by `tenantContext`. */
export type Vars = {
  principal: Principal;
  scope: TenantScope;
};

export type ApiEnv = { Variables: Vars };

export type PrincipalResolver = (req: Request) => Promise<Principal | null>;

/**
 * Resolves the caller to a Principal and mints a TenantScope.
 *
 * `authorize()` is the only producer of a TenantScope in the codebase, so this is
 * the single place a request becomes trusted. Everything downstream receives an
 * already-authorized scope and cannot widen it.
 */
export function tenantContext(resolvePrincipal: PrincipalResolver): MiddlewareHandler<ApiEnv> {
  return async (c: Context<ApiEnv>, next: Next) => {
    const principal = await resolvePrincipal(c.req.raw);
    if (!principal) return c.json({ error: 'unauthenticated' }, 401);

    const workspaceId = c.req.header('x-workspace-id') ?? null;
    // Default to TEST mode. An unspecified mode must never mean "live" — that
    // would make a forgotten header able to place a real, billable call.
    const mode = c.req.header('x-mode') === 'live' ? 'live' : 'test';

    c.set('principal', principal);
    c.set('scope', authorize(principal, { workspaceId, mode }));
    await next();
  };
}

/**
 * Maps domain errors to HTTP. Route handlers throw; they never build error
 * responses themselves, so status codes stay consistent across the whole surface.
 */
export function errorHandler(container: Container) {
  return (err: Error, c: Context): Response => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: 'validation_failed',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    if (err instanceof AuthorizationError) {
      return c.json(
        { error: 'forbidden', message: err.message, required: err.required },
        err.status as 403,
      );
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: 'not_found', message: err.message }, 404);
    }
    if (err instanceof ConflictError) {
      return c.json({ error: 'conflict', message: err.message }, 409);
    }
    // Never leak an internal message to the client — log it, return a generic body.
    container.logger.error('unhandled error', { message: err.message, stack: err.stack });
    return c.json({ error: 'internal_error' }, 500);
  };
}

/** Adds the API version to every response so clients can detect drift. */
export function versionHeader(version: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-api-version', version);
  };
}
