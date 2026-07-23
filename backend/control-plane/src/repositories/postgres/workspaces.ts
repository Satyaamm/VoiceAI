/**
 * PostgresWorkspaceRepository.
 *
 * Semantics are matched to `MemoryWorkspaceRepository` method for method, including
 * the one that matters most: a cross-tenant `get()` returns **null**, never the row
 * and never a 403. Two independent mechanisms produce that null — the explicit
 * `org_id = scope.orgId` predicate, and the RLS policy. Either one alone would be
 * sufficient; the point is that both would have to fail together.
 */

import { and, asc, count, eq, ilike, or } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { workspaces } from '../../db/schema.js';
import type { Workspace } from '../../domain/schemas.js';
import type { TenantScope, WorkspaceScope } from '../../domain/tenant.js';
import type { ListOptions, Page, WorkspaceRepository } from '../types.js';
import { ConflictError, NotFoundError } from '../types.js';
import {
  isUniqueViolation,
  likeTerm,
  rowToWorkspace,
  workspacePatchToRow,
  workspaceToRow,
} from './mappers.js';

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: TenantScope, opts: ListOptions = {}): Promise<Page<Workspace>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const term = opts.search ? likeTerm(opts.search) : undefined;
      const where = term
        ? and(
            eq(workspaces.orgId, scope.orgId),
            or(ilike(workspaces.name, term), ilike(workspaces.slug, term)),
          )
        : eq(workspaces.orgId, scope.orgId);

      // Two statements, one transaction, one snapshot — so `total` can never
      // disagree with `items` because of a concurrent insert.
      const totals = await db.select({ n: count() }).from(workspaces).where(where);
      const rows = await db
        .select()
        .from(workspaces)
        .where(where)
        .orderBy(asc(workspaces.name))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map(rowToWorkspace),
        total: totals[0]?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  async get(scope: TenantScope, workspaceId: string): Promise<Workspace | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, scope.orgId)))
        .limit(1);
      const row = rows[0];
      return row ? rowToWorkspace(row) : null;
    });
  }

  async findBySlug(scope: TenantScope, slug: string): Promise<Workspace | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, scope.orgId), eq(workspaces.slug, slug)))
        .limit(1);
      const row = rows[0];
      return row ? rowToWorkspace(row) : null;
    });
  }

  /** `orgId` always comes from the scope, never from the payload. */
  async create(scope: TenantScope, workspace: Workspace): Promise<Workspace> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      try {
        const rows = await db
          .insert(workspaces)
          .values(workspaceToRow(workspace, scope.orgId))
          .returning();
        const row = rows[0];
        if (!row) throw new Error('insert returned no row');
        return rowToWorkspace(row);
      } catch (err) {
        // `workspaces_org_slug_uq` — slugs are unique per org, not globally.
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            `workspace slug taken in this organization: ${workspace.slug}`,
          );
        }
        throw err;
      }
    });
  }

  async update(scope: WorkspaceScope, patch: Partial<Workspace>): Promise<Workspace> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const where = and(
        eq(workspaces.id, scope.workspaceId),
        eq(workspaces.orgId, scope.orgId),
      );

      const values = workspacePatchToRow(patch);
      if (Object.keys(values).length === 0) {
        const existing = await db.select().from(workspaces).where(where).limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('workspace', scope.workspaceId);
        return rowToWorkspace(row);
      }

      try {
        const rows = await db.update(workspaces).set(values).where(where).returning();
        const row = rows[0];
        if (!row) throw new NotFoundError('workspace', scope.workspaceId);
        return rowToWorkspace(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            `workspace slug taken in this organization: ${patch.slug ?? ''}`,
          );
        }
        throw err;
      }
    });
  }

  /**
   * Hard delete, cascading to agents, api keys, numbers, campaigns, calls, turns —
   * see the FK `ON DELETE CASCADE` chain in `0001_init.sql`. `audit_log` has no FK
   * and therefore survives, which is the whole reason it has no FK.
   */
  async delete(scope: WorkspaceScope): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(workspaces)
        .where(and(eq(workspaces.id, scope.workspaceId), eq(workspaces.orgId, scope.orgId)))
        .returning({ id: workspaces.id });
      if (rows.length === 0) throw new NotFoundError('workspace', scope.workspaceId);
    });
  }
}
