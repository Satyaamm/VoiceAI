/**
 * v1 — session bootstrap.
 *
 * One request returns everything the dashboard shell needs: user, orgs,
 * workspaces, effective permissions, and the just-in-time onboarding flags. The
 * frontend should never need a second round-trip to decide what to render.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';

export function sessionRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/session', async (c) => {
    const scope = c.get('scope');
    const principal = c.get('principal');

    const [user, org, workspaces] = await Promise.all([
      container.repositories.users.findById(principal.userId),
      container.repositories.orgs.get(scope),
      container.services.workspaces.list(scope, { pageSize: 100 }),
    ]);

    return c.json({
      user,
      organizations: org
        ? [{ id: org.id, name: org.name, slug: org.slug, role: principal.orgRole }]
        : [],
      workspaces: workspaces.items.map((w) => ({
        id: w.id,
        orgId: w.orgId,
        name: w.name,
        slug: w.slug,
        region: w.region,
        role: principal.workspaceRoles.get(w.id) ?? 'workspace_admin',
      })),
      currentOrgId: scope.orgId,
      currentWorkspaceId: scope.workspaceId,
      mode: scope.mode,
      permissions: [...scope.permissions],
      // Just-in-time onboarding (docs/11) — these drive contextual prompts, never
      // a blocking wizard.
      onboarding: {
        emailVerified: user?.emailVerified ?? false,
        hasTalkedToAgent: false,
        needsUserDetails: !user?.phone,
        needsOrgBillingDetails: !org?.billingEmail,
        needsRegionConfirmation: false,
        showProfileCard: !org?.industry,
      },
    });
  });

  return app;
}
