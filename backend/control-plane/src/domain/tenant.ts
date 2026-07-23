/**
 * Tenant scoping + authorization.
 *
 * docs/10 §Scoping rules: every query is scoped, and that is enforced by TYPES,
 * not by convention. Repository methods take a `TenantScope` as their first
 * argument — there is no `findAll()` without one, so "forgot to filter by org" is
 * a compile error rather than a data breach.
 *
 * Postgres RLS on org_id is the second line of defence (see migrations).
 */

import type { Mode, OrgRole, WorkspaceRole } from './schemas.js';

/**
 * Brand symbol. Declared but never exported, so a TenantScope cannot be forged by
 * an object literal anywhere in the codebase — `authorize()` is the only producer.
 */
declare const AUTHORIZED: unique symbol;

/** Proof that a request has been authorized into a tenant. */
export interface TenantScope {
  readonly orgId: string;
  /** Null for org-level operations (billing, members, workspace list). */
  readonly workspaceId: string | null;
  readonly userId: string;
  readonly mode: Mode;
  readonly permissions: ReadonlySet<Permission>;
  readonly [AUTHORIZED]: true;
}

export type Permission =
  | 'org:read' | 'org:write' | 'org:billing' | 'org:members'
  | 'workspace:read' | 'workspace:write' | 'workspace:create'
  | 'agent:read' | 'agent:write' | 'agent:publish'
  | 'call:read' | 'call:read_pii' | 'call:place_test'
  | 'number:manage' | 'campaign:manage' | 'apikey:manage';

// ---------------------------------------------------------------------------
// Role -> permission mapping. Single source of truth; docs/10 §Roles.
// ---------------------------------------------------------------------------

const ORG_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: [
    'org:read', 'org:write', 'org:billing', 'org:members',
    'workspace:read', 'workspace:create',
  ],
  admin: ['org:read', 'org:write', 'org:members', 'workspace:read', 'workspace:create'],
  billing_admin: ['org:read', 'org:billing'],
  member: ['org:read'],
};

const WORKSPACE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  workspace_admin: [
    'workspace:read', 'workspace:write',
    'agent:read', 'agent:write', 'agent:publish',
    'call:read', 'call:read_pii', 'call:place_test',
    'number:manage', 'campaign:manage', 'apikey:manage',
  ],
  developer: [
    'workspace:read',
    'agent:read', 'agent:write', 'agent:publish',
    'call:read', 'call:read_pii', 'call:place_test',
    'campaign:manage',
  ],
  // analyst/viewer deliberately lack call:read_pii — they see transcripts with PII
  // masked. This is what makes it safe to give QA and BPO staff trace access.
  analyst: ['workspace:read', 'agent:read', 'call:read'],
  viewer: ['workspace:read', 'agent:read', 'call:read'],
};

/**
 * Org owners and admins get implicit admin on every workspace in the org.
 * Everyone else needs an explicit grant.
 */
const IMPLICIT_WORKSPACE_ADMIN: OrgRole[] = ['owner', 'admin'];

export interface Principal {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  /** Explicit per-workspace grants. */
  workspaceRoles: ReadonlyMap<string, WorkspaceRole>;
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly required: Permission,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * The only way to produce a TenantScope. Resolves effective permissions for
 * (user, org, workspace) and fails closed.
 */
export function authorize(
  principal: Principal,
  opts: { workspaceId?: string | null; mode?: Mode } = {},
): TenantScope {
  const permissions = new Set<Permission>(ORG_PERMISSIONS[principal.orgRole]);
  const workspaceId = opts.workspaceId ?? null;

  if (workspaceId) {
    const explicit = principal.workspaceRoles.get(workspaceId);
    const effective: WorkspaceRole | undefined =
      explicit ??
      (IMPLICIT_WORKSPACE_ADMIN.includes(principal.orgRole) ? 'workspace_admin' : undefined);

    if (!effective) {
      throw new AuthorizationError(
        `no access to workspace ${workspaceId}`,
        'workspace:read',
        404, // 404, not 403 — don't confirm the workspace exists to a stranger
      );
    }
    for (const p of WORKSPACE_PERMISSIONS[effective]) permissions.add(p);
  }

  return {
    orgId: principal.orgId,
    workspaceId,
    userId: principal.userId,
    mode: opts.mode ?? 'test',
    permissions,
  } as unknown as TenantScope;
}

/** Throwing check — use at the top of every mutating handler. */
export function require_(scope: TenantScope, permission: Permission): void {
  if (!scope.permissions.has(permission)) {
    throw new AuthorizationError(`missing permission: ${permission}`, permission);
  }
}

export function can(scope: TenantScope, permission: Permission): boolean {
  return scope.permissions.has(permission);
}

/**
 * Scope for trusted internal processes that have no human principal — the trace
 * recorder, the retention sweep, the dialer, webhook delivery.
 *
 * Deliberately NOT a back door. Three constraints keep it honest:
 *
 *   1. It still requires an explicit orgId/workspaceId, so RLS and every
 *      repository filter apply exactly as they do for a user request.
 *   2. `userId` is 'system', which is what lands in the audit log — a system
 *      action is always distinguishable from a user action.
 *   3. Permissions are passed in explicitly by the caller. There is no
 *      "all permissions" shortcut, so a sweep job that only needs to delete
 *      cannot also read PII.
 */
export function systemScope(opts: {
  orgId: string;
  workspaceId?: string | null;
  mode?: Mode;
  permissions: Permission[];
  /** Why this system process is acting. Recorded in the audit log. */
  reason: string;
}): TenantScope {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId ?? null,
    userId: 'system',
    mode: opts.mode ?? 'live',
    permissions: new Set(opts.permissions),
    systemReason: opts.reason,
  } as unknown as TenantScope;
}

/** Narrows a scope that must have a workspace. Keeps repositories honest. */
export interface WorkspaceScope extends TenantScope {
  readonly workspaceId: string;
}

export function requireWorkspace(scope: TenantScope): WorkspaceScope {
  if (!scope.workspaceId) {
    throw new AuthorizationError('workspace required for this operation', 'workspace:read', 400);
  }
  return scope as WorkspaceScope;
}
