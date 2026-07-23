/**
 * v1 — organization and workspace routes.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import {
  createWorkspaceInput,
  listQuery,
  updateWorkspaceInput,
} from '../../domain/schemas.js';
import { NotFoundError } from '../../repositories/types.js';
import { taxIdLabelFor } from '../../services/compliance.js';

export function workspaceRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/org', async (c) => {
    const scope = c.get('scope');
    const org = await container.repositories.orgs.get(scope);
    if (!org) throw new NotFoundError('organization', scope.orgId);
    // The tax-ID label is jurisdiction-specific (VAT / EIN / USt-IdNr.); the UI
    // must never hardcode it.
    return c.json({ ...org, taxIdLabel: taxIdLabelFor(org.country) });
  });

  app.get('/workspaces', async (c) => {
    const scope = c.get('scope');
    const q = listQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await container.services.workspaces.list(scope, q));
  });

  app.post('/workspaces', async (c) => {
    const scope = c.get('scope');
    const input = createWorkspaceInput.parse(await c.req.json());
    return c.json(await container.services.workspaces.create(scope, input), 201);
  });

  app.get('/workspaces/:id', async (c) => {
    const scope = c.get('scope');
    return c.json(await container.services.workspaces.get(scope, c.req.param('id')));
  });

  app.patch('/workspaces/:id', async (c) => {
    const scope = c.get('scope');
    const patch = updateWorkspaceInput.parse(await c.req.json());
    return c.json(await container.services.workspaces.update(scope, c.req.param('id'), patch));
  });

  return app;
}
