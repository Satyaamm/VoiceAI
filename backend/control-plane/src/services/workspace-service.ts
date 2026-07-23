/**
 * Workspace service — business rules that must not live in route handlers.
 *
 * The important one: region immutability. docs/11 §B — region is inferred, stays
 * editable while the workspace holds no real call data, and locks on first live
 * call. That is a rule about the LIFECYCLE, not a database constraint, so it lives
 * here where it can be tested.
 */

import { newId } from '../domain/ids.js';
import {
  complianceProfileSchema,
  spendCapsSchema,
  type CreateWorkspaceInput,
  type Region,
  type Workspace,
} from '../domain/schemas.js';
import type { z } from 'zod';
import type { updateWorkspaceInput } from '../domain/schemas.js';
import { require_, requireWorkspace, type TenantScope, type WorkspaceScope } from '../domain/tenant.js';

type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInput>;

/**
 * Narrows an org-level scope to a specific workspace. Safe because the caller has
 * already loaded that workspace through `get()`, which enforces the org boundary.
 */
function authorizedWorkspaceScope(scope: TenantScope, workspaceId: string): TenantScope {
  return { ...scope, workspaceId } as unknown as TenantScope;
}
import { ConflictError, NotFoundError, type ListOptions, type OrganizationRepository, type WorkspaceRepository } from '../repositories/types.js';
import { defaultComplianceProfile, defaultRegionFor, REGION_META_BLOC } from './region.js';

export class WorkspaceService {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly orgs: OrganizationRepository,
  ) {}

  async list(scope: TenantScope, opts?: ListOptions) {
    require_(scope, 'workspace:read');
    return this.workspaces.list(scope, opts);
  }

  async get(scope: TenantScope, workspaceId: string): Promise<Workspace> {
    require_(scope, 'workspace:read');
    const ws = await this.workspaces.get(scope, workspaceId);
    if (!ws) throw new NotFoundError('workspace', workspaceId);
    return ws;
  }

  async create(scope: TenantScope, input: CreateWorkspaceInput): Promise<Workspace> {
    require_(scope, 'workspace:create');

    const org = await this.orgs.get(scope);
    if (!org) throw new NotFoundError('organization', scope.orgId);

    const slug = input.slug ?? slugify(input.name);
    if (await this.workspaces.findBySlug(scope, slug)) {
      throw new ConflictError(`workspace slug already in use: ${slug}`);
    }

    // Compliance defaults derive from the ORG's country, then are overridable.
    // Failing conservative is the only defensible default here.
    const compliance = complianceProfileSchema.parse({
      ...defaultComplianceProfile(org.country),
      ...(input.compliance ?? {}),
    });

    const workspace: Workspace = {
      id: newId('workspace'),
      orgId: scope.orgId,
      name: input.name,
      slug,
      description: input.description,
      region: input.region,
      regionLocked: false,
      compliance,
      spendCaps: spendCapsSchema.parse(input.spendCaps ?? {}),
      createdAt: new Date().toISOString(),
      stats: { agentCount: 0, numberCount: 0, callsToday: 0 },
    };

    this.assertResidencyCoherent(workspace);
    return this.workspaces.create(scope, workspace);
  }

  async update(
    scope: TenantScope,
    workspaceId: string,
    patch: UpdateWorkspaceInput,
  ): Promise<Workspace> {
    const ws = await this.get(scope, workspaceId);
    const wsScope = requireWorkspace(
      authorizedWorkspaceScope(scope, workspaceId),
    );
    require_(wsScope, 'workspace:write');

    // Nested config is MERGED, not replaced — a PATCH that sets one compliance
    // field must not silently blank the other twelve.
    const next: Partial<Workspace> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.slug !== undefined) next.slug = patch.slug;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.compliance) {
      next.compliance = complianceProfileSchema.parse({ ...ws.compliance, ...patch.compliance });
    }
    if (patch.spendCaps) {
      next.spendCaps = spendCapsSchema.parse({ ...ws.spendCaps, ...patch.spendCaps });
    }

    // Region is immutable once locked. Reject loudly rather than silently ignoring —
    // a silent no-op means a customer believes their data moved when it didn't.
    if (patch.region && patch.region !== ws.region) {
      if (ws.regionLocked) {
        throw new ConflictError(
          `region is locked for this workspace (call data exists in ${ws.region}). ` +
            `Changing residency requires a supported migration, not a settings change.`,
        );
      }
      next.region = patch.region;
    }

    this.assertResidencyCoherent({ ...ws, ...next });
    // `regionLocked` is system-owned and never accepted from a client.
    return this.workspaces.update(wsScope, next);
  }

  /**
   * Called at the first LIVE call. After this, region cannot change.
   * Idempotent — safe to call on every dispatch.
   */
  async lockRegion(scope: TenantScope, workspaceId: string): Promise<Workspace> {
    const ws = await this.get(scope, workspaceId);
    if (ws.regionLocked) return ws;
    const wsScope = requireWorkspace(authorizedWorkspaceScope(scope, workspaceId));
    return this.workspaces.update(wsScope, { regionLocked: true });
  }

  /**
   * A workspace permitted to call EU numbers must store its data in the EU.
   * Catching this at configuration time is far better than at audit time.
   */
  private assertResidencyCoherent(ws: Workspace): void {
    const bloc = REGION_META_BLOC[ws.region];
    const euJurisdictions = ws.compliance.jurisdictions.filter((c) => isEuCountry(c));
    if (euJurisdictions.length && bloc !== 'EU') {
      throw new ConflictError(
        `workspace targets EU jurisdictions (${euJurisdictions.join(', ')}) but its region ` +
          `"${ws.region}" stores data outside the EU. Choose eu-west or eu-central.`,
      );
    }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

// Local import guard to avoid a cycle with compliance.ts
function isEuCountry(country: string): boolean {
  return EU.has(country.toUpperCase());
}
const EU = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT',
  'LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO',
]);

export { defaultRegionFor };
export type { Region };
