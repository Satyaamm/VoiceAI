/**
 * Auth, identity and onboarding routes.
 *
 * Two families, and the split matters:
 *   - `/auth/*`  UNauthenticated. Signup, login, verification, logout, me.
 *   - `/v1/*`    Authenticated and tenant-scoped by the middleware in
 *                `server.ts`; handlers read `c.get('scope')` and never re-derive
 *                permissions themselves.
 *
 * Handlers stay thin: parse -> authorize -> call a service -> serialise. Every
 * rule in here that looks like policy is a call into a service, by design.
 */

import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Container } from '../../container.js';
import {
  acceptInviteInput,
  createApiKeyInput,
  inviteInput,
  loginInput,
  orgBillingDetailsInput,
  resendVerificationInput,
  signupInput,
  userDetailsInput,
  verifyEmailInput,
} from '../../domain/auth-schemas.js';
import { authorize, require_, requireWorkspace, type Principal, type TenantScope } from '../../domain/tenant.js';
import { NotFoundError } from '../../repositories/types.js';
import { taxIdLabelFor } from '../../services/compliance.js';
import {
  AuthenticationError,
  SESSION_COOKIE_NAME,
  type AuthService,
  type IssuedSession,
} from '../../services/auth-service.js';
import type { MembershipService } from '../../services/membership-service.js';
import type { InvitationService } from '../../services/invitation-service.js';
import type { ApiKeyService } from '../../services/apikey-service.js';

/** The services this module needs on top of the base container. */
export interface AuthServices {
  auth: AuthService;
  memberships: MembershipService;
  invitations: InvitationService;
  apiKeys: ApiKeyService;
}

/** What `container.ts` must expose once these services are wired in. */
export type AuthContainer = Container & {
  services: Container['services'] & AuthServices;
};

type Vars = { principal: Principal; scope: TenantScope };
export type AuthApp = Hono<{ Variables: Vars }>;
type AuthCtx = Context<{ Variables: Vars }>;

const isProd = () => process.env.NODE_ENV === 'production';

export function registerAuthRoutes(app: AuthApp, container: AuthContainer): void {
  const { auth, memberships, invitations, apiKeys } = container.services;

  // -- Error mapping for this module ---------------------------------------
  // `server.ts` owns the global `onError` and does not know about
  // AuthenticationError, and Hono resolves a thrown error at the handler that
  // threw it — an error-mapping *middleware* would never see it. So each
  // handler is wrapped instead, which keeps server.ts untouched and keeps a
  // failed login a 401 rather than a 500.
  const guard =
    (handler: (c: AuthCtx) => Promise<Response>) =>
    async (c: AuthCtx): Promise<Response> => {
      try {
        return await handler(c);
      } catch (err) {
        if (err instanceof AuthenticationError) {
          return c.json({ error: err.code, message: err.message }, err.status as 401);
        }
        throw err;
      }
    };

  const get = (path: string, h: (c: AuthCtx) => Promise<Response>) => app.get(path, guard(h));
  const post = (path: string, h: (c: AuthCtx) => Promise<Response>) => app.post(path, guard(h));
  const patch = (path: string, h: (c: AuthCtx) => Promise<Response>) => app.patch(path, guard(h));
  const del = (path: string, h: (c: AuthCtx) => Promise<Response>) => app.delete(path, guard(h));

  // =========================================================================
  // /auth — unauthenticated
  // =========================================================================

  /**
   * Signup. ONE request from "email + password" to "here is your agent id":
   * user, org, workspace, sample agent, owner membership, session, verification
   * code. docs/11 §A — under 60 seconds to the first conversation, no forms.
   *
   * With an `inviteToken` it joins the inviting org instead of provisioning a
   * personal one, so an invited teammate never gets a duplicate tenant.
   */
  post('/auth/signup', async (c) => {
    const input = signupInput.parse(await c.req.json());

    if (input.inviteToken) {
      const result = await invitations.accept(
        input.inviteToken,
        { password: input.password, timezone: input.timezone, locale: input.locale },
        { userAgent: c.req.header('user-agent'), ip: clientIp(c.req.raw) },
      );
      writeSessionCookie(c, result.session);
      return c.json(
        {
          user: result.user,
          orgId: result.orgId,
          session: { expiresAt: result.session.expiresAt, token: result.session.token },
          accountCreated: result.accountCreated,
          next: { action: 'open_workspace' as const },
        },
        201,
      );
    }

    const result = await auth.signup({
      email: input.email,
      password: input.password,
      country: input.country,
      timezone: input.timezone,
      locale: input.locale,
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c.req.raw),
    });

    writeSessionCookie(c, result.session);
    return c.json(
      {
        user: result.user,
        organization: result.organization,
        workspace: result.workspace,
        agent: result.agent,
        session: { expiresAt: result.session.expiresAt, token: result.session.token },
        emailVerification: result.emailVerification,
        joinableOrg: result.joinableOrg,
        // The client's next call is the conversation, not another form.
        next: result.next,
      },
      201,
    );
  });

  post('/auth/login', async (c) => {
    const input = loginInput.parse(await c.req.json());
    const result = await auth.login(input.email, input.password, {
      orgId: input.orgId,
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c.req.raw),
    });
    writeSessionCookie(c, result.session);
    return c.json({
      user: result.user,
      orgId: result.orgId,
      session: { expiresAt: result.session.expiresAt, token: result.session.token },
    });
  });

  /**
   * Email verification. A 6-digit code, not a magic link — signup and inbox are
   * frequently on different devices (docs/10 §Signup).
   *
   * Identified by session when there is one, by email otherwise: the code is
   * itself the secret, and the attempt cap lives in the service.
   */
  post('/auth/verify-email', async (c) => {
    const input = verifyEmailInput.parse(await c.req.json());
    const userId = await identify(c, input.email);
    if (!userId) throw new AuthenticationError('sign in or provide your email address', 'session_invalid', 401);
    const user = await auth.verifyEmail(userId, input.code);
    return c.json({ user });
  });

  post('/auth/verify-email/resend', async (c) => {
    const input = resendVerificationInput.parse(await c.req.json().catch(() => ({})));
    const userId = await identify(c, input.email);
    if (!userId) throw new AuthenticationError('sign in or provide your email address', 'session_invalid', 401);
    const user = await container.repositories.users.findById(userId);
    if (!user) throw new NotFoundError('user', userId);
    return c.json(await auth.issueVerificationCode(user));
  });

  post('/auth/logout', async (c) => {
    const token = readToken(c);
    if (token) await auth.logout(token);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204); // idempotent: logging out twice is a success
  });

  /** Lightweight "who am I" for the app shell. 401 when unauthenticated. */
  get('/auth/me', async (c) => {
    const token = readToken(c);
    const verified = token ? await auth.verifySessionToken(token) : null;
    if (!verified) return c.json({ error: 'unauthenticated' }, 401);

    const [user, membership] = await Promise.all([
      container.repositories.users.findById(verified.userId),
      memberships.findForUserInOrg(verified.userId, verified.orgId),
    ]);
    if (!user || !membership) return c.json({ error: 'unauthenticated' }, 401);

    const scope = authorize(
      {
        userId: user.id,
        orgId: verified.orgId,
        orgRole: membership.role,
        workspaceRoles: new Map(membership.workspaceRoles.map((g) => [g.workspaceId, g.role])),
      },
      { mode: 'test' },
    );
    const org = await container.repositories.orgs.get(scope);
    const all = await memberships.listForUser(user.id);

    return c.json({
      user,
      currentOrgId: verified.orgId,
      orgRole: membership.role,
      organizations: all.map((m) => ({ id: m.orgId, role: m.role })),
      permissions: [...scope.permissions],
      // Just-in-time prompts, never blockers (docs/11 §B).
      onboarding: {
        emailVerified: user.emailVerified,
        hasTalkedToAgent: false,
        needsUserDetails: !user.familyName || !user.phone,
        needsOrgBillingDetails: !org?.billingEmail,
        needsRegionConfirmation: false,
        showProfileCard: !org?.industry,
      },
    });
  });

  /**
   * Accepting an invite when you have no account yet — necessarily
   * unauthenticated, which is why it lives under /auth as well as /v1.
   */
  get('/auth/invitations/:token', async (c) =>
    c.json(await invitations.preview(param(c, 'token'))),
  );

  post('/auth/invitations/:token/accept', async (c) => {
    const input = acceptInviteInput.parse(await c.req.json().catch(() => ({})));
    const token = readToken(c);
    const verified = token ? await auth.verifySessionToken(token) : null;
    const result = await invitations.accept(param(c, 'token'), input, {
      actorUserId: verified?.userId,
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c.req.raw),
    });
    writeSessionCookie(c, result.session);
    return c.json({
      user: result.user,
      orgId: result.orgId,
      accountCreated: result.accountCreated,
      session: { expiresAt: result.session.expiresAt, token: result.session.token },
    });
  });

  // =========================================================================
  // /v1 — authenticated; `scope` is set by the middleware in server.ts
  // =========================================================================

  /** Just-in-time user details: asked at the first invite or first live call. */
  patch('/v1/me', async (c) => {
    const scope = c.get('scope');
    const patch = userDetailsInput.parse(await c.req.json());
    const user = await auth.updateUserDetails(scope.userId, patch);
    return c.json(user);
  });

  /** Just-in-time billing details: asked when a payment method is added. */
  patch('/v1/org/billing', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:billing');
    const patch = orgBillingDetailsInput.parse(await c.req.json());
    const org = await container.repositories.orgs.update(scope, patch);
    // The tax-ID label is jurisdiction-specific; the UI must never hardcode it.
    return c.json({ ...org, taxIdLabel: taxIdLabelFor(org.country) });
  });

  // -- Members --------------------------------------------------------------
  get('/v1/members', async (c) => c.json({ items: await memberships.list(c.get('scope')) }));

  // -- Invitations ----------------------------------------------------------
  get('/v1/invitations', async (c) =>
    c.json({ items: await invitations.list(c.get('scope')) }),
  );

  /** The token is returned exactly once, here, for the invite link. */
  post('/v1/invitations', async (c) => {
    const scope = c.get('scope');
    const input = inviteInput.parse(await c.req.json());
    const { invitation, token } = await invitations.create(scope, input);
    return c.json({ invitation, token }, 201);
  });

  /** Accepting while already signed in. Same service, same single-use rules. */
  post('/v1/invitations/:token/accept', async (c) => {
    const scope = c.get('scope');
    const input = acceptInviteInput.parse(await c.req.json().catch(() => ({})));
    const result = await invitations.accept(param(c, 'token'), input, {
      actorUserId: scope.userId,
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c.req.raw),
    });
    writeSessionCookie(c, result.session);
    return c.json({
      user: result.user,
      orgId: result.orgId,
      accountCreated: result.accountCreated,
      session: { expiresAt: result.session.expiresAt, token: result.session.token },
    });
  });

  del('/v1/invitations/:id', async (c) => {
    const scope = c.get('scope');
    return c.json(await invitations.revoke(scope, param(c, 'id')));
  });

  // -- API keys -------------------------------------------------------------
  // Workspace-scoped: `requireWorkspace` 400s when `x-workspace-id` is absent,
  // so there is no path to an org-wide key.

  get('/v1/api-keys', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({ items: await apiKeys.list(scope) });
  });

  /**
   * The ONLY response that ever contains the secret. Show it in a modal with an
   * explicit acknowledgement — docs/11 §9.
   */
  post('/v1/api-keys', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createApiKeyInput.parse(await c.req.json());
    const { apiKey, secret } = await apiKeys.create(scope, input);
    return c.json({ apiKey, secret, warning: 'This secret is shown once and cannot be recovered.' }, 201);
  });

  del('/v1/api-keys/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await apiKeys.revoke(scope, param(c, 'id')));
  });

  // -- helpers --------------------------------------------------------------

  /** Session first, e-mail fallback — used only by the verification endpoints. */
  async function identify(c: AuthCtx, email?: string): Promise<string | null> {
    const token = readToken(c);
    const verified = token ? await auth.verifySessionToken(token) : null;
    if (verified) return verified.userId;
    if (!email) return null;
    const user = await container.repositories.users.findByEmail(email);
    return user?.id ?? null;
  }
}

// ---------------------------------------------------------------------------

/**
 * HttpOnly so JavaScript cannot read it, SameSite=Lax so a cross-site POST
 * cannot ride it, Secure in production. The token is ALSO returned in the body
 * for non-browser clients that cannot hold a cookie jar.
 */
function writeSessionCookie(c: AuthCtx, session: IssuedSession): void {
  setCookie(c, SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1_000)),
  });
}

function readToken(c: AuthCtx): string | null {
  const authorization = c.req.header('authorization');
  if (authorization) {
    const [scheme, ...rest] = authorization.trim().split(/\s+/);
    if (scheme && scheme.toLowerCase() === 'bearer' && rest.length) return rest.join('');
    return null;
  }
  return getCookie(c, SESSION_COOKIE_NAME) ?? null;
}

/**
 * On an unparameterised `Context` a path param is `string | undefined`. It can
 * only be missing if the route pattern and the lookup disagree, which is a
 * routing bug — so fail loudly rather than passing `undefined` into a service.
 */
function param(c: AuthCtx, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new NotFoundError('route parameter', name);
  return value;
}

/** Best-effort client IP for the session audit trail. Never trusted for auth. */
function clientIp(req: Request): string | undefined {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip') || undefined;
}
