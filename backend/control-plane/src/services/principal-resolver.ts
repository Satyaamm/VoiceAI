/**
 * The single seam where a raw HTTP request becomes a `Principal`.
 *
 * `src/api/server.ts` calls this and nothing else for authentication, so adding
 * a credential type (SSO, service account, signed webhook) is a change here and
 * nowhere else. It replaces the Phase-1 dev resolver in `src/main.ts`.
 *
 * Two credential types today:
 *   - **Session** — cookie `vai_session`, or `Authorization: Bearer v1.…`
 *   - **API key** — `Authorization: Bearer key_live_…` / `x-api-key: key_test_…`
 *
 * It fails closed: any malformed, unknown, expired, revoked, or unmembered
 * credential resolves to `null`, which the server turns into a flat 401. No
 * branch distinguishes *why* — that distinction is an oracle.
 */

import type { Principal } from '../domain/tenant.js';
import type { MembershipRepository } from '../repositories/auth-repository.js';
import { SESSION_COOKIE_NAME, type AuthService } from './auth-service.js';
import { parseSecret, type ApiKeyService } from './apikey-service.js';

export interface PrincipalResolverDeps {
  auth: AuthService;
  apiKeys: ApiKeyService;
  memberships: MembershipRepository;
  /** Name of the session cookie. Overridable for multi-env cookie isolation. */
  cookieName?: string;
}

export type PrincipalResolver = (req: Request) => Promise<Principal | null>;

export function createPrincipalResolver(deps: PrincipalResolverDeps): PrincipalResolver {
  const cookieName = deps.cookieName ?? SESSION_COOKIE_NAME;

  return async function resolvePrincipal(req: Request): Promise<Principal | null> {
    const presented = readCredential(req, cookieName);
    if (!presented) return null;

    // An API key is self-describing via its prefix, so there is no ambiguity
    // about which verifier to run — and no fallback from one to the other.
    if (parseSecret(presented)) {
      return deps.apiKeys.verify(presented);
    }
    return resolveSession(deps, presented);
  };
}

async function resolveSession(
  deps: PrincipalResolverDeps,
  token: string,
): Promise<Principal | null> {
  const verified = await deps.auth.verifySessionToken(token);
  if (!verified) return null;

  // The session says which org; the MEMBERSHIP says what you may do there.
  // Roles are re-read on every request, so a demotion takes effect immediately
  // rather than at the next login.
  const membership = await deps.memberships.findForUserInOrg(verified.userId, verified.orgId);
  if (!membership) return null;

  void deps.auth.touchSession(verified.session.id);

  return {
    userId: verified.userId,
    orgId: verified.orgId,
    orgRole: membership.role,
    workspaceRoles: new Map(membership.workspaceRoles.map((g) => [g.workspaceId, g.role])),
  };
}

// ---------------------------------------------------------------------------

/** Header first, cookie second — an explicit header always wins. */
function readCredential(req: Request, cookieName: string): string | null {
  const apiKeyHeader = req.headers.get('x-api-key')?.trim();
  if (apiKeyHeader) return apiKeyHeader;

  const authorization = req.headers.get('authorization');
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/);
    const value = rest.join('');
    if (scheme && value && scheme.toLowerCase() === 'bearer') return value;
    return null; // an Authorization header we don't understand is not a fallback
  }

  return readCookie(req.headers.get('cookie'), cookieName);
}

/**
 * Minimal cookie parsing — the resolver only ever receives a raw `Request`, so
 * it cannot depend on the framework's cookie helpers.
 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}
