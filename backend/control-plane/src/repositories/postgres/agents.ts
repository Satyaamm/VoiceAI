/**
 * PostgresAgentRepository.
 *
 * Every method takes a `WorkspaceScope`, so every query filters on BOTH `org_id` and
 * `workspace_id` — matching `MemoryAgentRepository` exactly, including cross-tenant
 * `get()` returning null.
 *
 * `list()` sorts by `updated_at DESC` and is served by `agents_ws_updated_idx`
 * (workspace_id, updated_at DESC), so the common case is an index scan with no sort
 * node at all.
 */

import { and, count, desc, eq, ilike, or } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { agents } from '../../db/schema.js';
import type { Agent } from '../../domain/schemas.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type { AgentRepository, ListOptions, Page } from '../types.js';
import { NotFoundError } from '../types.js';
import { agentPatchToRow, agentToRow, likeTerm, rowToAgent } from './mappers.js';

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: WorkspaceScope, opts: ListOptions = {}): Promise<Page<Agent>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const tenant = and(
        eq(agents.orgId, scope.orgId),
        eq(agents.workspaceId, scope.workspaceId),
      );
      const term = opts.search ? likeTerm(opts.search) : undefined;
      const where = term
        ? and(tenant, or(ilike(agents.name, term), ilike(agents.description, term)))
        : tenant;

      const totals = await db.select({ n: count() }).from(agents).where(where);
      const rows = await db
        .select()
        .from(agents)
        .where(where)
        .orderBy(desc(agents.updatedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map(rowToAgent),
        total: totals[0]?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  async get(scope: WorkspaceScope, agentId: string): Promise<Agent | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(agents).where(this.scoped(scope, agentId)).limit(1);
      const row = rows[0];
      return row ? rowToAgent(row) : null;
    });
  }

  /** Tenancy comes from the scope; anything in the payload is overwritten. */
  async create(scope: WorkspaceScope, agent: Agent): Promise<Agent> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .insert(agents)
        .values(agentToRow(agent, scope.orgId, scope.workspaceId))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToAgent(row);
    });
  }

  /**
   * `updated_at` is stamped server-side on every update, exactly as the memory
   * implementation does — the list ordering depends on it, so it must not be
   * something a caller can forget or forge.
   */
  async update(
    scope: WorkspaceScope,
    agentId: string,
    patch: Partial<Agent>,
  ): Promise<Agent> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .update(agents)
        .set({ ...agentPatchToRow(patch), updatedAt: new Date() })
        .where(this.scoped(scope, agentId))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('agent', agentId);
      return rowToAgent(row);
    });
  }

  async delete(scope: WorkspaceScope, agentId: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(agents)
        .where(this.scoped(scope, agentId))
        .returning({ id: agents.id });
      if (rows.length === 0) throw new NotFoundError('agent', agentId);
    });
  }

  private scoped(scope: WorkspaceScope, agentId: string) {
    return and(
      eq(agents.id, agentId),
      eq(agents.orgId, scope.orgId),
      eq(agents.workspaceId, scope.workspaceId),
    );
  }
}
