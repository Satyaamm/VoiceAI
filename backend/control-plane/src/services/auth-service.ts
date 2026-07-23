/**
 * Authentication + the auto-provisioning half of onboarding.
 *
 * The load-bearing decision in this file is `signup()`. docs/11 §Revised design:
 * onboarding is DEFERRED, not a wizard. Signing up creates the user, the org, a
 * "Production" workspace, a working sample agent, an owner membership and a live
 * session in ONE call, then hands back the ids the client needs to open a
 * conversation. The hierarchy exists from second one — the user simply never
 * filled a form for it. Target: under 60 seconds to first conversation.
 *
 * Crypto notes:
 *   - Passwords: scrypt, per-user 16-byte random salt, N=2^15. Node stdlib only.
 *   - Session tokens: HMAC-SHA256 over a compact payload, plus a server-side
 *     session row so logout is a real revocation and not a client-side wish.
 *   - Verification codes: 6 digits, HMAC'd at rest, expiring, attempt-capped.
 *   - Every comparison of secret material goes through `timingSafeEqualHex`.
 *
 * Nothing here logs, returns, or serialises password material. The only value
 * ever handed out in plaintext is a freshly minted session token.
 */

import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { newId } from '../domain/ids.js';
import {
  spendCapsSchema,
  type Agent,
  type Organization,
  type User,
  type Workspace,
} from '../domain/schemas.js';
import { authorize, requireWorkspace, type Principal } from '../domain/tenant.js';
import type {
  CredentialRecord,
  CredentialRepository,
  MembershipRepository,
  SessionRecord,
  SessionRepository,
  VerificationCodeRepository,
} from '../repositories/auth-repository.js';
import { ConflictError, type OrganizationRepository, type UserRepository } from '../repositories/types.js';
import type { Logger } from '../core/patterns/factory.js';
import { defaultComplianceProfile, defaultRegionFor } from './compliance.js';
import { findJoinableOrgFor, splitEmail } from './membership-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { AgentService } from './agent-service.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** ~64MB of memory per hash. Deliberately expensive; that is the entire point. */
const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, keylen: 64 } as const;
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;
const VERIFICATION_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const SESSION_COOKIE_NAME = 'vai_session';

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface AuthSecrets {
  /** Signs session tokens. */
  sessionSecret: string;
  /** Peppers hashes of codes, invite tokens and API keys. */
  hashPepper: string;
}

/**
 * Reads secrets from the environment, or generates ephemeral ones for local dev.
 * Ephemeral secrets mean every restart invalidates every session — which is the
 * correct, loud failure mode for a missing secret in production.
 */
export function resolveAuthSecrets(logger?: Logger): AuthSecrets {
  const sessionSecret = process.env.AUTH_SESSION_SECRET;
  const hashPepper = process.env.AUTH_HASH_PEPPER;
  if (sessionSecret && hashPepper) return { sessionSecret, hashPepper };

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SESSION_SECRET and AUTH_HASH_PEPPER are required in production',
    );
  }
  logger?.warn('auth secrets not set — generating ephemeral dev secrets', {
    effect: 'sessions and API keys do not survive a restart',
  });
  return {
    sessionSecret: sessionSecret ?? randomBytes(32).toString('hex'),
    hashPepper: hashPepper ?? randomBytes(32).toString('hex'),
  };
}

// ---------------------------------------------------------------------------
// Primitives shared with the other auth services
// ---------------------------------------------------------------------------

/** Keyed digest. Fast by design — used for values that already carry full entropy. */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Constant-time compare of two hex digests. Length is checked first (and leaks
 * only the length of a *digest*, which is fixed anyway); `timingSafeEqual`
 * throws on mismatched buffers, so this guard is required, not optional.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_credentials'
      | 'invalid_code'
      | 'code_expired'
      | 'too_many_attempts'
      | 'session_invalid'
      | 'email_taken' = 'invalid_credentials',
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface IssuedSession {
  token: string;
  expiresAt: string;
  session: SessionRecord;
}

export interface SignupResult {
  user: User;
  organization: Organization;
  /** Auto-provisioned. The user never saw a form for it. */
  workspace: Workspace;
  /** A working sample agent — the first screen is "talk to it", not "create one". */
  agent: Agent;
  session: IssuedSession;
  emailVerification: { required: true; expiresAt: string; devCode?: string };
  /**
   * Domain-based org discovery (docs/11 §5). Non-null when a *verified* org owns
   * this email domain. We still provision so the user is never blocked, and the
   * UI offers "Join Acme?" with a request-to-join instead of silently splitting
   * the account into a duplicate org.
   */
  joinableOrg: { id: string; name: string; slug: string } | null;
  /** Everything the client needs to open the conversation, in one hop. */
  next: { action: 'talk_to_agent'; workspaceId: string; agentId: string; mode: 'test' };
}

export interface AuthServiceDeps {
  users: UserRepository;
  orgs: OrganizationRepository;
  credentials: CredentialRepository;
  verificationCodes: VerificationCodeRepository;
  sessions: SessionRepository;
  /**
   * Written directly, not through MembershipService: the very first membership
   * is a bootstrap — there is no TenantScope until it exists.
   */
  memberships: MembershipRepository;
  workspaces: WorkspaceService;
  agents: AgentService;
  secrets: AuthSecrets;
  logger: Logger;
  /**
   * Audit sink. SOC 2 CC6.2 (registration/authorization of users) and CC6.1
   * require authentication events to be recorded, including FAILED logins —
   * a failed-login trail is how credential stuffing gets detected.
   *
   * Optional so unit tests need not supply one, but production wiring always does.
   */
  audit?: {
    record(
      scope: { orgId: string; workspaceId: string | null; userId: string },
      action: string,
      opts: {
        resourceType: string;
        resourceId?: string | null;
        metadata?: Record<string, unknown>;
        outcome?: 'success' | 'failure';
      },
    ): Promise<unknown>;
  };
  /** Optional delivery sink. Absent in dev; the code is then only logged at debug. */
  mailer?: {
    sendVerificationCode(to: string, code: string): Promise<void>;
  };
}

export interface RegisterUserInput {
  email: string;
  password?: string;
  firstName?: string;
  familyName?: string;
  timezone?: string;
  locale?: string;
  emailVerified?: boolean;
}

export interface SignupOptions {
  email: string;
  password: string;
  country?: string;
  timezone?: string;
  locale?: string;
  userAgent?: string;
  ip?: string;
}

// ---------------------------------------------------------------------------

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  // -- Passwords -----------------------------------------------------------

  /** scrypt with a fresh per-user 16-byte salt. */
  async hashPassword(password: string): Promise<{ salt: string; hash: string }> {
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return { salt, hash: derived.toString('hex') };
  }

  private async verifyPassword(password: string, record: CredentialRecord): Promise<boolean> {
    const derived = await scrypt(password, record.salt, record.params.keylen, {
      N: record.params.N,
      r: record.params.r,
      p: record.params.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqualHex(derived.toString('hex'), record.hash);
  }

  /**
   * Burns a comparable amount of CPU when no credential exists, so "unknown
   * email" and "wrong password" are indistinguishable from the outside. Without
   * this, login is a free user-enumeration oracle.
   */
  private async dummyVerify(password: string): Promise<void> {
    await scrypt(password, 'no-such-user-salt', SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_MAXMEM,
    }).catch(() => Buffer.alloc(0));
  }

  // -- Users ---------------------------------------------------------------

  /**
   * Creates a user and (optionally) its credential. Public because invitation
   * acceptance provisions accounts for people who never signed up.
   *
   * Names are DERIVED from the email local part, never asked for at signup —
   * they are collected just-in-time at the first invite or first live call. An
   * empty `familyName` is the honest representation of "not collected yet"; the
   * `userDetailsInput` schema requires a real one the moment it is submitted.
   */
  async registerUser(input: RegisterUserInput): Promise<User> {
    const email = input.email.toLowerCase();
    if (await this.deps.users.findByEmail(email)) {
      throw new AuthenticationError('email already registered', 'email_taken', 409);
    }

    const derived = deriveNames(email);
    const user: User = {
      id: newId('user'),
      email,
      emailVerified: input.emailVerified ?? false,
      firstName: input.firstName ?? derived.firstName,
      familyName: input.familyName ?? derived.familyName,
      timezone: input.timezone ?? 'UTC',
      locale: input.locale ?? 'en-US',
      createdAt: new Date().toISOString(),
    };

    const created = await this.deps.users.create(user);
    if (input.password) await this.setPassword(created.id, input.password);
    return created;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const { salt, hash } = await this.hashPassword(password);
    await this.deps.credentials.upsert({
      userId,
      algorithm: 'scrypt',
      salt,
      hash,
      params: { ...SCRYPT_PARAMS },
      updatedAt: new Date().toISOString(),
    });
  }

  // -- Signup: the 60-second path ------------------------------------------

  /**
   * ONE request: user + credential + org + workspace + sample agent + owner
   * membership + session + verification code. The response carries the agent id,
   * so the client's very next action is opening a conversation.
   */
  async signup(input: SignupOptions): Promise<SignupResult> {
    const user = await this.registerUser({
      email: input.email,
      password: input.password,
      timezone: input.timezone,
      locale: input.locale,
    });

    const country = (input.country ?? 'US').toUpperCase();

    // Domain discovery runs BEFORE provisioning so the response can offer
    // "Join Acme?" — but it never blocks, and never auto-joins: a verified
    // domain still requires an explicit request-to-join (docs/11 §5, §E).
    const joinable = await findJoinableOrgFor(this.deps.orgs, user.email);

    const organization = await this.provisionOrganization(user, country, input.timezone);

    const principal: Principal = {
      userId: user.id,
      orgId: organization.id,
      orgRole: 'owner',
      workspaceRoles: new Map(),
    };
    await this.deps.memberships.create({
      id: newId('membership'),
      orgId: organization.id,
      userId: user.id,
      role: 'owner',
      workspaceRoles: [],
      joinedAt: new Date().toISOString(),
    });

    // Test mode throughout: a brand-new account cannot dial a real person.
    const orgScope = authorize(principal, { mode: 'test' });
    const workspace = await this.deps.workspaces.create(orgScope, {
      name: 'Production',
      slug: 'production',
      region: defaultRegionFor(country),
      compliance: defaultComplianceProfile(country),
      spendCaps: spendCapsSchema.parse({ monthlyUsd: 500, breachAction: 'wrap_up' }),
    });

    const wsScope = requireWorkspace(
      authorize(principal, { workspaceId: workspace.id, mode: 'test' }),
    );
    const agent = await this.deps.agents.create(wsScope, sampleAgentSpec(user.locale, country));

    const session = await this.issueSession(user.id, organization.id, {
      userAgent: input.userAgent,
      ip: input.ip,
    });
    const verification = await this.issueVerificationCode(user);

    this.deps.logger.info('signup provisioned', {
      userId: user.id,
      orgId: organization.id,
      workspaceId: workspace.id,
      agentId: agent.id,
      joinableOrgId: joinable?.id ?? null,
    });

    // SOC 2 CC6.2. Note the metadata carries no email or personal data — the
    // audit record outlives the account it describes (docs/14 §3 item 3).
    await this.deps.audit?.record(
      { orgId: organization.id, workspaceId: workspace.id, userId: user.id },
      'auth.signup',
      {
        resourceType: 'user',
        resourceId: user.id,
        metadata: {
          country,
          region: workspace.region,
          autoProvisioned: true,
          joinableOrgOffered: joinable !== null,
        },
      },
    );

    return {
      user,
      organization,
      workspace,
      agent,
      session,
      emailVerification: verification,
      joinableOrg: joinable
        ? { id: joinable.id, name: joinable.name, slug: joinable.slug }
        : null,
      next: {
        action: 'talk_to_agent',
        workspaceId: workspace.id,
        agentId: agent.id,
        mode: 'test',
      },
    };
  }

  /**
   * Org name is inferred, never asked for (docs/11 §4): a corporate domain
   * becomes "Acme", a free-mail address becomes "<First>'s Organization".
   * `verifiedDomains` stays empty — a domain claim needs DNS TXT proof, and
   * auto-join off an unproven domain is exactly how tenants get merged wrongly.
   */
  private async provisionOrganization(
    user: User,
    country: string,
    timezone?: string,
  ): Promise<Organization> {
    const { domain } = splitEmail(user.email);
    const corporate = domain ? companyNameFromDomain(domain) : null;
    const name = corporate ?? `${user.firstName || 'My'}'s Organization`;

    const org: Organization = {
      id: newId('org'),
      parentOrgId: null, // reseller/BPO trees hang here later — docs/12 §5
      name,
      slug: await this.uniqueOrgSlug(name),
      country,
      timezone: timezone ?? user.timezone,
      currency: currencyFor(country),
      verifiedDomains: [],
      createdAt: new Date().toISOString(),
    };
    return this.deps.orgs.create(org);
  }

  private async uniqueOrgSlug(name: string): Promise<string> {
    const base = slugify(name);
    if (!(await this.deps.orgs.findBySlug(base))) return base;
    for (let i = 0; i < 25; i += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`.slice(0, 48);
      if (!(await this.deps.orgs.findBySlug(candidate))) return candidate;
    }
    throw new ConflictError('could not allocate an organization slug');
  }

  // -- Login ---------------------------------------------------------------

  async login(
    email: string,
    password: string,
    opts: { orgId?: string; userAgent?: string; ip?: string } = {},
  ): Promise<{ user: User; session: IssuedSession; orgId: string }> {
    const user = await this.deps.users.findByEmail(email.toLowerCase());
    const credential = user ? await this.deps.credentials.findByUserId(user.id) : null;

    if (!user || !credential) {
      await this.dummyVerify(password);
      throw new AuthenticationError('invalid email or password');
    }
    if (!(await this.verifyPassword(password, credential))) {
      throw new AuthenticationError('invalid email or password');
    }

    // Fail closed: a user with no membership has nothing to be scoped into.
    const memberships = await this.deps.memberships.listForUser(user.id);
    const chosen = opts.orgId
      ? memberships.find((m) => m.orgId === opts.orgId)
      : memberships[0];
    if (!chosen) throw new AuthenticationError('no organization for this account', 'invalid_credentials', 403);

    await this.deps.audit?.record(
      { orgId: chosen.orgId, workspaceId: null, userId: user.id },
      'auth.login',
      { resourceType: 'user', resourceId: user.id, metadata: { ip: opts.ip } },
    );

    const session = await this.issueSession(user.id, chosen.orgId, {
      userAgent: opts.userAgent,
      ip: opts.ip,
    });
    return { user, session, orgId: chosen.orgId };
  }

  // -- Email verification --------------------------------------------------

  /** Issues a fresh 6-digit code and invalidates any outstanding one. */
  async issueVerificationCode(
    user: User,
  ): Promise<{ required: true; expiresAt: string; devCode?: string }> {
    await this.deps.verificationCodes.consumeAllForUser(user.id, 'email_verification');

    // randomInt is CSPRNG-backed; Math.random here would be a real weakness.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const expiresAt = new Date(now + VERIFICATION_TTL_MS).toISOString();

    await this.deps.verificationCodes.create({
      id: `vc_${randomBytes(12).toString('hex')}`, // internal only; never addressed externally
      userId: user.id,
      email: user.email,
      codeHash: hmacHex(this.deps.secrets.hashPepper, `${user.id}:${code}`),
      purpose: 'email_verification',
      attempts: 0,
      expiresAt,
      createdAt: new Date(now).toISOString(),
    });

    if (this.deps.mailer) {
      await this.deps.mailer.sendVerificationCode(user.email, code);
    } else {
      this.deps.logger.debug('verification code issued (no mailer configured)', {
        userId: user.id,
      });
    }

    // Opt-in, explicit, and never on in production — for local end-to-end runs.
    const expose = process.env.AUTH_EXPOSE_CODES === '1' && process.env.NODE_ENV !== 'production';
    return expose
      ? { required: true, expiresAt, devCode: code }
      : { required: true, expiresAt };
  }

  async verifyEmail(userId: string, code: string): Promise<User> {
    const record = await this.deps.verificationCodes.findLatestForUser(
      userId,
      'email_verification',
    );
    if (!record) throw new AuthenticationError('no verification code outstanding', 'invalid_code', 400);
    if (record.consumedAt) throw new AuthenticationError('code already used', 'invalid_code', 400);
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new AuthenticationError('verification code expired', 'code_expired', 400);
    }
    if (record.attempts >= VERIFICATION_MAX_ATTEMPTS) {
      // Burn the code rather than allowing an unbounded guessing budget.
      await this.deps.verificationCodes.update(record.id, {
        consumedAt: new Date().toISOString(),
      });
      throw new AuthenticationError('too many attempts — request a new code', 'too_many_attempts', 429);
    }

    const expected = hmacHex(this.deps.secrets.hashPepper, `${userId}:${code}`);
    if (!timingSafeEqualHex(expected, record.codeHash)) {
      await this.deps.verificationCodes.update(record.id, { attempts: record.attempts + 1 });
      throw new AuthenticationError('invalid verification code', 'invalid_code', 400);
    }

    await this.deps.verificationCodes.update(record.id, {
      consumedAt: new Date().toISOString(),
    });
    return this.deps.users.update(userId, { emailVerified: true });
  }

  // -- Sessions ------------------------------------------------------------

  /**
   * Token layout: `v1.<payload>.<sig>` where payload is base64url JSON
   * `{sid,uid,oid,exp}` and sig is HMAC-SHA256 over the payload segment.
   *
   * Signed AND server-side: the signature makes forgery infeasible, the session
   * row makes revocation immediate. Either alone is insufficient.
   */
  async issueSession(
    userId: string,
    orgId: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<IssuedSession> {
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    const record: SessionRecord = {
      // Session ids are opaque and never user-visible, so they get raw entropy
      // rather than a prefixed domain id.
      id: `sess_${randomBytes(16).toString('hex')}`,
      userId,
      orgId,
      userAgent: meta.userAgent,
      ip: meta.ip,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      lastSeenAt: new Date(now).toISOString(),
    };
    await this.deps.sessions.create(record);
    return { token: this.signSessionToken(record), expiresAt, session: record };
  }

  private signSessionToken(record: SessionRecord): string {
    const payload = base64url(
      Buffer.from(
        JSON.stringify({
          sid: record.id,
          uid: record.userId,
          oid: record.orgId,
          exp: Math.floor(Date.parse(record.expiresAt) / 1_000),
        }),
      ),
    );
    const sig = hmacHex(this.deps.secrets.sessionSecret, payload);
    return `v1.${payload}.${sig}`;
  }

  /**
   * Verifies signature, expiry, and the server-side record. Returns null rather
   * than throwing: the resolver treats every failure identically (fail closed),
   * and a distinguishable error here would leak which check failed.
   */
  async verifySessionToken(
    token: string,
  ): Promise<{ session: SessionRecord; userId: string; orgId: string } | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [version, payload, sig] = parts;
    if (version !== 'v1' || !payload || !sig) return null;

    const expected = hmacHex(this.deps.secrets.sessionSecret, payload);
    if (!timingSafeEqualHex(expected, sig)) return null;

    let claims: { sid?: unknown; uid?: unknown; oid?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      return null;
    }
    const { sid, uid, oid, exp } = claims;
    if (typeof sid !== 'string' || typeof uid !== 'string' || typeof oid !== 'string') return null;
    if (typeof exp !== 'number' || exp * 1_000 <= Date.now()) return null;

    const session = await this.deps.sessions.findById(sid);
    if (!session || session.revokedAt) return null;
    if (session.userId !== uid || session.orgId !== oid) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) return null;

    return { session, userId: session.userId, orgId: session.orgId };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.deps.sessions
      .update(sessionId, { lastSeenAt: new Date().toISOString() })
      .catch(() => undefined);
  }

  /** Idempotent. Logging out of an already-dead session is a success, not a 404. */
  async logout(token: string): Promise<void> {
    const verified = await this.verifySessionToken(token);
    if (verified) await this.deps.sessions.revoke(verified.session.id);
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.deps.sessions.revokeAllForUser(userId);
  }

  // -- Just-in-time profile ------------------------------------------------

  /** Collected at the first invite or first live call, never at signup. */
  async updateUserDetails(userId: string, patch: Partial<User>): Promise<User> {
    // Identity, verification state and timestamps are system-owned.
    const {
      id: _id,
      email: _email,
      emailVerified: _verified,
      createdAt: _createdAt,
      ...safe
    } = patch;
    return this.deps.users.update(userId, safe);
  }
}

// ---------------------------------------------------------------------------
// Inference helpers — "never ask what you can infer" (docs/11 §4)
// ---------------------------------------------------------------------------

const FREE_MAIL_TITLES = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'icloud', 'me', 'proton', 'protonmail', 'gmx', 'web', 'aol', 'mail', 'zoho', 'yandex', 'qq', '163']);

export function deriveNames(email: string): { firstName: string; familyName: string } {
  const { local } = splitEmail(email);
  const parts = (local ?? '')
    .replace(/\+.*$/, '')
    .split(/[._\-\s]+/)
    .filter(Boolean);
  const first = parts[0] ?? 'there';
  const rest = parts.slice(1).join(' ');
  return { firstName: titleCase(first), familyName: rest ? titleCase(rest) : '' };
}

/** `acme-corp.com` -> `Acme Corp`. Null for free-mail providers. */
export function companyNameFromDomain(domain: string): string | null {
  const label = domain.split('.')[0] ?? '';
  if (!label || FREE_MAIL_TITLES.has(label.toLowerCase())) return null;
  return label.split(/[-_]+/).filter(Boolean).map(titleCase).join(' ') || null;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Org slugs must be >= 2 chars and start/end alphanumeric (organizationSchema).
  return s.length >= 2 ? s : `org-${randomBytes(3).toString('hex')}`;
}

const EU_CURRENCY = new Set([
  'AT','BE','CY','DE','EE','ES','FI','FR','GR','HR','IE','IT','LT','LU','LV','MT','NL','PT','SI','SK',
]);

export function currencyFor(country: string): string {
  const cc = country.toUpperCase();
  if (EU_CURRENCY.has(cc)) return 'EUR';
  if (cc === 'GB') return 'GBP';
  if (cc === 'IN') return 'INR';
  if (cc === 'CH') return 'CHF';
  if (cc === 'CA') return 'CAD';
  if (cc === 'AU') return 'AUD';
  return 'USD';
}

/**
 * The sample agent. It has to be genuinely usable on the first click — a stub
 * that says "configure me" would defeat the entire onboarding thesis.
 */
/**
 * Language for the auto-provisioned sample agent.
 *
 * Falls back to the org's COUNTRY when the browser locale is uninformative — a
 * German company signing up from an `en-GB` browser should still get a German
 * sample agent. docs/13 §4 makes non-English quality the wedge, so the first
 * thing a European customer hears must not be English by accident.
 */
export function sampleAgentSpec(locale: string, country?: string) {
  const fromCountry: Record<string, string> = {
    DE: 'de-DE', AT: 'de-DE', CH: 'de-DE',
    FR: 'fr-FR', BE: 'fr-FR',
    ES: 'es-ES', MX: 'es-ES', AR: 'es-ES',
    IT: 'it-IT',
    NL: 'nl-NL',
    GB: 'en-GB',
  };

  const language = locale.startsWith('de')
    ? 'de-DE'
    : locale.startsWith('fr')
      ? 'fr-FR'
      : locale.startsWith('es')
        ? 'es-ES'
        : locale.startsWith('it')
          ? 'it-IT'
          : locale.startsWith('nl')
            ? 'nl-NL'
            : (country && fromCountry[country.toUpperCase()]) || 'en-US';
  return {
    name: 'Sample Support Agent',
    description: 'A working inbound support agent, pre-provisioned so you can talk to it now.',
    language,
    prompt:
      'You are a friendly, concise support agent for a company evaluating this platform. ' +
      'Greet the caller, answer in one or two sentences, and keep the conversation moving. ' +
      'If you do not know something, say so plainly and offer to hand over to a human.',
    voice: { voiceId: language === 'de-DE' ? 'mock-de-f' : 'mock-en-f', register: 'informal' as const },
  };
}
