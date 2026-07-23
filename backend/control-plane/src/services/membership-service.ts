/**
 * Org and workspace membership.
 *
 * Two rules carry this file:
 *
 * 1. **The last owner cannot be removed or demoted.** An org with no owner has
 *    no one who can pay the bill, transfer ownership, or delete it — it is an
 *    unrecoverable state that only support can fix. docs/10 §Roles.
 * 2. **Domain-based org discovery** (docs/11 §5). The second person from
 *    `@acme.com` is *offered* the existing org rather than silently given a
 *    duplicate one. Offered, never auto-joined, and only for a domain the org
 *    has actually proven it controls via DNS TXT — otherwise anyone who
 *    registers `acme.com` in our table inherits Acme's tenants.
 */

import { newId } from '../domain/ids.js';
import type { OrgRole, Organization, User, WorkspaceRole } from '../domain/schemas.js';
import { require_, type TenantScope } from '../domain/tenant.js';
import type {
  MembershipRepository,
  OrgMembershipRecord,
  WorkspaceGrant,
} from '../repositories/auth-repository.js';
import {
  ConflictError,
  NotFoundError,
  type OrganizationRepository,
  type UserRepository,
  type WorkspaceRepository,
} from '../repositories/types.js';

// ---------------------------------------------------------------------------
// Email helpers — shared with auth-service (which must not import this class).
// ---------------------------------------------------------------------------

export function splitEmail(email: string): { local: string | null; domain: string | null } {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return { local: null, domain: null };
  return { local: email.slice(0, at).toLowerCase(), domain: email.slice(at + 1).toLowerCase() };
}

/**
 * Consumer mailbox providers. A shared inbox domain must never imply a shared
 * organization — "everyone at gmail.com works together" is the failure mode.
 */
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'web.de', 'aol.com',
  'mail.com', 'zoho.com', 'yandex.com', 'qq.com', '163.com', 'fastmail.com',
]);

/**
 * Free function so `AuthService` can use it during signup without depending on
 * `MembershipService` (and creating a cycle). Returns the org that has *verified*
 * this email's domain, or null.
 */
export async function findJoinableOrgFor(
  orgs: OrganizationRepository,
  email: string,
): Promise<Organization | null> {
  const { domain } = splitEmail(email);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  return orgs.findByVerifiedDomain(domain);
}

// ---------------------------------------------------------------------------
// DTOs — mirror `frontend/src/lib/contract.ts` OrgMembership.
// ---------------------------------------------------------------------------

export interface MemberView {
  id: string;
  orgId: string;
  user: Pick<User, 'id' | 'email' | 'firstName' | 'familyName' | 'avatarUrl'>;
  role: OrgRole;
  workspaceRoles: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole }>;
  joinedAt: string;
  lastActiveAt?: string;
}

export interface MembershipServiceDeps {
  memberships: MembershipRepository;
  users: UserRepository;
  orgs: OrganizationRepository;
  workspaces: WorkspaceRepository;
}

export class MembershipService {
  constructor(private readonly deps: MembershipServiceDeps) {}

  // -- Reads ---------------------------------------------------------------

  async list(scope: TenantScope): Promise<MemberView[]> {
    require_(scope, 'org:read');
    const rows = await this.deps.memberships.list(scope);
    return Promise.all(rows.map((r) => this.toView(scope, r)));
  }

  async get(scope: TenantScope, membershipId: string): Promise<MemberView> {
    require_(scope, 'org:read');
    const row = await this.requireMembership(scope, membershipId);
    return this.toView(scope, row);
  }

  /** Pre-authorization: this is what builds a Principal. */
  async listForUser(userId: string): Promise<OrgMembershipRecord[]> {
    return this.deps.memberships.listForUser(userId);
  }

  async findForUserInOrg(userId: string, orgId: string): Promise<OrgMembershipRecord | null> {
    return this.deps.memberships.findForUserInOrg(userId, orgId);
  }

  /** docs/11 §5 — "Join Acme?" instead of a fifth duplicate Acme. */
  async findJoinableOrg(email: string): Promise<Organization | null> {
    return findJoinableOrgFor(this.deps.orgs, email);
  }

  // -- Org membership CRUD -------------------------------------------------

  /**
   * Adds an existing user to an org. Invitation acceptance and reseller
   * provisioning both funnel through here so the invariants live in one place.
   */
  async addMember(
    scope: TenantScope,
    input: { userId: string; role: OrgRole; workspaceGrants?: WorkspaceGrant[] },
  ): Promise<OrgMembershipRecord> {
    require_(scope, 'org:members');
    return this.addMemberUnscoped(scope.orgId, input);
  }

  /**
   * The same operation for flows where the actor has no scope in the target org
   * — accepting an invitation, most importantly. The invitation itself is the
   * authorization, which is why this is separate and explicitly named.
   */
  async addMemberUnscoped(
    orgId: string,
    input: { userId: string; role: OrgRole; workspaceGrants?: WorkspaceGrant[] },
  ): Promise<OrgMembershipRecord> {
    const existing = await this.deps.memberships.findForUserInOrg(input.userId, orgId);
    if (existing) throw new ConflictError('user is already a member of this organization');

    return this.deps.memberships.create({
      id: newId('membership'),
      orgId,
      userId: input.userId,
      role: input.role,
      workspaceRoles: dedupeGrants(input.workspaceGrants ?? []),
      joinedAt: new Date().toISOString(),
    });
  }

  /**
   * Role change. Rejects the demotion of the last owner, and refuses to let a
   * non-owner mint owners — `org:members` is enough to manage a team, not enough
   * to hand out the keys to billing and deletion.
   */
  async changeOrgRole(
    scope: TenantScope,
    membershipId: string,
    role: OrgRole,
  ): Promise<OrgMembershipRecord> {
    require_(scope, 'org:members');
    const membership = await this.requireMembership(scope, membershipId);
    if (membership.role === role) return membership;

    if (role === 'owner' || membership.role === 'owner') {
      this.requireOwnerActor(scope, 'only an owner can grant or revoke ownership');
    }
    if (membership.role === 'owner') {
      await this.assertNotLastOwner(scope.orgId, 'demote');
    }

    return this.deps.memberships.update(scope, membershipId, { role });
  }

  async removeMember(scope: TenantScope, membershipId: string): Promise<void> {
    require_(scope, 'org:members');
    const membership = await this.requireMembership(scope, membershipId);

    if (membership.role === 'owner') {
      this.requireOwnerActor(scope, 'only an owner can remove an owner');
      await this.assertNotLastOwner(scope.orgId, 'remove');
    }
    await this.deps.memberships.delete(scope, membershipId);
  }

  /** Self-service exit. Same invariant: the last owner cannot walk out. */
  async leave(scope: TenantScope): Promise<void> {
    const membership = await this.deps.memberships.findForUserInOrg(scope.userId, scope.orgId);
    if (!membership) throw new NotFoundError('membership', scope.userId);
    if (membership.role === 'owner') await this.assertNotLastOwner(scope.orgId, 'remove');
    await this.deps.memberships.delete(scope, membership.id);
  }

  // -- Workspace membership CRUD -------------------------------------------

  /**
   * Grants (or replaces) a workspace role. The workspace is read through the
   * scoped repository first, so a grant can never reference another org's
   * workspace — cross-tenant references are forbidden (docs/10 §Scoping rule 5).
   */
  async setWorkspaceRole(
    scope: TenantScope,
    membershipId: string,
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<OrgMembershipRecord> {
    require_(scope, 'org:members');
    const membership = await this.requireMembership(scope, membershipId);

    const workspace = await this.deps.workspaces.get(scope, workspaceId);
    if (!workspace) throw new NotFoundError('workspace', workspaceId);

    const next = membership.workspaceRoles.filter((g) => g.workspaceId !== workspaceId);
    next.push({ workspaceId, role });
    return this.deps.memberships.update(scope, membershipId, { workspaceRoles: next });
  }

  async removeWorkspaceRole(
    scope: TenantScope,
    membershipId: string,
    workspaceId: string,
  ): Promise<OrgMembershipRecord> {
    require_(scope, 'org:members');
    const membership = await this.requireMembership(scope, membershipId);
    return this.deps.memberships.update(scope, membershipId, {
      workspaceRoles: membership.workspaceRoles.filter((g) => g.workspaceId !== workspaceId),
    });
  }

  async touchLastActive(orgId: string, userId: string): Promise<void> {
    const membership = await this.deps.memberships.findForUserInOrg(userId, orgId);
    if (!membership) return;
    // Scope-free by construction: we just proved the pair exists in this org.
    const scope = { orgId } as unknown as TenantScope;
    await this.deps.memberships
      .update(scope, membership.id, { lastActiveAt: new Date().toISOString() })
      .catch(() => undefined);
  }

  // -- Invariants ----------------------------------------------------------

  private async assertNotLastOwner(orgId: string, action: 'remove' | 'demote'): Promise<void> {
    const owners = await this.deps.memberships.countByRole(orgId, 'owner');
    if (owners <= 1) {
      throw new ConflictError(
        `cannot ${action} the last owner of this organization — ` +
          'promote another member to owner first',
      );
    }
  }

  private requireOwnerActor(scope: TenantScope, message: string): void {
    // `org:billing` is the owner-only permission in the role table, which makes
    // it a reliable proxy for "is an owner" without re-deriving roles here.
    if (!scope.permissions.has('org:billing')) {
      throw new ConflictError(message);
    }
  }

  private async requireMembership(
    scope: TenantScope,
    membershipId: string,
  ): Promise<OrgMembershipRecord> {
    const row = await this.deps.memberships.get(scope, membershipId);
    if (!row) throw new NotFoundError('membership', membershipId);
    return row;
  }

  private async toView(scope: TenantScope, row: OrgMembershipRecord): Promise<MemberView> {
    const user = await this.deps.users.findById(row.userId);
    const workspaceRoles = await Promise.all(
      row.workspaceRoles.map(async (g) => {
        const ws = await this.deps.workspaces.get(scope, g.workspaceId);
        return { workspaceId: g.workspaceId, workspaceName: ws?.name ?? 'unknown', role: g.role };
      }),
    );
    return {
      id: row.id,
      orgId: row.orgId,
      user: {
        id: row.userId,
        email: user?.email ?? '',
        firstName: user?.firstName ?? '',
        familyName: user?.familyName ?? '',
        avatarUrl: user?.avatarUrl,
      },
      role: row.role,
      workspaceRoles,
      joinedAt: row.joinedAt,
      lastActiveAt: row.lastActiveAt,
    };
  }
}

function dedupeGrants(grants: WorkspaceGrant[]): WorkspaceGrant[] {
  const byWorkspace = new Map<string, WorkspaceGrant>();
  for (const g of grants) byWorkspace.set(g.workspaceId, g);
  return [...byWorkspace.values()];
}
