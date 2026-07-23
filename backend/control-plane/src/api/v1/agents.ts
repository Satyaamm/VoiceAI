/**
 * v1 — agent routes.
 *
 * Every handler narrows to a WorkspaceScope first, so none of them can operate
 * across a whole organization by accident.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import {
  createAgentInput,
  listQuery,
  publishAgentInput,
  updateAgentInput,
} from '../../domain/schemas.js';
import { requireWorkspace } from '../../domain/tenant.js';

export function agentRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/agents', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const q = listQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await container.services.agents.list(scope, q));
  });

  app.post('/agents', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createAgentInput.parse(await c.req.json());
    return c.json(await container.services.agents.create(scope, input), 201);
  });

  app.get('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await container.services.agents.get(scope, c.req.param('id')));
  });

  app.patch('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateAgentInput.parse(await c.req.json());
    return c.json(await container.services.agents.update(scope, c.req.param('id'), patch));
  });

  app.post('/agents/:id/publish', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = publishAgentInput.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await container.services.agents.publish(scope, c.req.param('id'), body.changeNote),
    );
  });

  app.get('/agents/:id/versions', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({
      items: await container.services.agents.listVersions(scope, c.req.param('id')),
    });
  });

  app.post('/agents/:id/rollback/:version', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const version = Number(c.req.param('version'));
    return c.json(await container.services.agents.rollback(scope, c.req.param('id'), version));
  });

  app.delete('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await container.services.agents.delete(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
