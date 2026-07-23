/**
 * Postgres repositories — the Phase 2 storage layer.
 *
 * These satisfy the same interfaces as `repositories/memory.ts`, so switching the
 * container over is a one-line change:
 *
 *     // src/container.ts
 *     const handle = createDb();
 *     const repositories = {
 *       users:      new PostgresUserRepository(handle),
 *       orgs:       new PostgresOrganizationRepository(handle),
 *       workspaces: new PostgresWorkspaceRepository(handle),
 *       agents:     new PostgresAgentRepository(handle),
 *     };
 *
 * (The `Container` interface currently names the Memory classes concretely. Widening
 * those four fields to `UserRepository | OrganizationRepository | …` from
 * `repositories/types.ts` is the accompanying edit — a change to container.ts, which
 * is outside this module's remit.)
 */

export { PostgresUserRepository } from './users.js';
export { PostgresOrganizationRepository } from './organizations.js';
export { PostgresWorkspaceRepository } from './workspaces.js';
export { PostgresAgentRepository } from './agents.js';
export { createDb, registerShutdown, TENANT_SETTING } from '../../db/client.js';
export type { DbHandle, Database, DbConfig } from '../../db/client.js';
