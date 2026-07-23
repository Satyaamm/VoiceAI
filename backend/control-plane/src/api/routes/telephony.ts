/**
 * Telephony routes — numbers and campaigns.
 *
 * Same discipline as `server.ts`: parse -> authorize -> call a service ->
 * serialise. Permission checks live in the services (`require_`), not here.
 *
 * Registered from the composition root rather than inlined into `createServer`, so
 * the telephony surface can ship, be feature-flagged, or be removed without
 * touching the core server file.
 */

import type { Hono } from 'hono';

import {
  createCampaignInput,
  createLeadInput,
  purchaseNumberInput,
  searchNumbersQuery,
  updateCampaignInput,
  assignNumberInput,
} from '../../domain/telephony-schemas.js';
import { listQuery } from '../../domain/schemas.js';
import { requireWorkspace, type Principal, type TenantScope } from '../../domain/tenant.js';
import {
  CampaignStateError,
  LocalPresenceRequiredError,
} from '../../repositories/telephony-repository.js';
import type { CampaignService } from '../../services/campaign-service.js';
import type { NumberService } from '../../services/number-service.js';

/** Populated by the auth middleware in `createServer`. */
type Vars = {
  principal: Principal;
  scope: TenantScope;
};

export type TelephonyApp = Hono<{ Variables: Vars }>;

/**
 * The slice of the container these routes need. Structural, so the real
 * `Container` satisfies it once `numbers` and `campaigns` are wired in.
 */
export interface TelephonyContainer {
  services: {
    numbers: NumberService;
    campaigns: CampaignService;
  };
}

export function registerTelephonyRoutes(app: TelephonyApp, container: TelephonyContainer): void {
  const { numbers, campaigns } = container.services;

  // -- Error mapping -------------------------------------------------------
  // Scoped middleware rather than `app.onError`: Hono's onError is a single slot,
  // so registering one here would REPLACE the server's global handler and silently
  // break Zod/NotFound/Conflict mapping everywhere else. Anything we don't own is
  // rethrown and lands in the server's handler unchanged.
  const mapErrors: Parameters<TelephonyApp['use']>[1] = async (c, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof LocalPresenceRequiredError) {
        // 422, not 400: the request is well-formed, the *account* is not eligible.
        return c.json(
          {
            error: err.code,
            country: err.country,
            message: err.message,
            requirements: err.requirements,
          },
          422,
        );
      }
      if (err instanceof CampaignStateError) {
        return c.json({ error: err.code, message: err.message }, 409);
      }
      throw err;
    }
    return undefined;
  };

  app.use('/v1/numbers', mapErrors);
  app.use('/v1/numbers/*', mapErrors);
  app.use('/v1/campaigns', mapErrors);
  app.use('/v1/campaigns/*', mapErrors);

  // =========================================================================
  // Numbers
  // =========================================================================

  /**
   * Available inventory. Declared BEFORE `/v1/numbers/:id` so "available" is never
   * matched as an id.
   */
  app.get('/v1/numbers/available', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const raw = Object.fromEntries(new URL(c.req.url).searchParams);
    const query = searchNumbersQuery.parse({
      ...raw,
      country: typeof raw['country'] === 'string' ? raw['country'].toUpperCase() : raw['country'],
      capabilities: raw['capabilities'] ? String(raw['capabilities']).split(',') : undefined,
    });
    return c.json(await numbers.search(scope, query));
  });

  app.get('/v1/numbers', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const params = new URL(c.req.url).searchParams;
    const q = listQuery.parse(Object.fromEntries(params));
    const country = params.get('country');
    const assignedAgentId = params.get('agentId');
    return c.json(
      await numbers.list(scope, {
        ...q,
        ...(country ? { country: country.toUpperCase() } : {}),
        ...(assignedAgentId ? { assignedAgentId } : {}),
      }),
    );
  });

  app.post('/v1/numbers', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = purchaseNumberInput.parse(await c.req.json());
    return c.json(await numbers.purchase(scope, input), 201);
  });

  app.get('/v1/numbers/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await numbers.get(scope, c.req.param('id')));
  });

  app.post('/v1/numbers/:id/assign', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = assignNumberInput.parse(await c.req.json());
    return c.json(await numbers.assign(scope, c.req.param('id'), body.agentId));
  });

  app.post('/v1/numbers/:id/reputation/refresh', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await numbers.refreshReputation(scope, c.req.param('id')));
  });

  app.delete('/v1/numbers/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await numbers.release(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  // =========================================================================
  // Campaigns
  // =========================================================================

  app.get('/v1/campaigns', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const params = new URL(c.req.url).searchParams;
    const q = listQuery.parse(Object.fromEntries(params));
    const agentId = params.get('agentId');
    return c.json(await campaigns.list(scope, { ...q, ...(agentId ? { agentId } : {}) }));
  });

  app.post('/v1/campaigns', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createCampaignInput.parse(await c.req.json());
    return c.json(await campaigns.create(scope, input), 201);
  });

  app.get('/v1/campaigns/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await campaigns.get(scope, c.req.param('id')));
  });

  app.patch('/v1/campaigns/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateCampaignInput.parse(await c.req.json());
    return c.json(await campaigns.update(scope, c.req.param('id'), patch));
  });

  app.delete('/v1/campaigns/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await campaigns.delete(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/v1/campaigns/:id/start', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await campaigns.start(scope, c.req.param('id')));
  });

  app.post('/v1/campaigns/:id/pause', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await campaigns.pause(scope, c.req.param('id')));
  });

  app.post('/v1/campaigns/:id/stop', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await campaigns.stop(scope, c.req.param('id')));
  });

  app.get('/v1/campaigns/:id/progress', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await campaigns.progress(scope, c.req.param('id')));
  });

  // -- Leads ---------------------------------------------------------------

  app.get('/v1/campaigns/:id/leads', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const q = listQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await campaigns.listLeads(scope, c.req.param('id'), q));
  });

  app.post('/v1/campaigns/:id/leads', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = await c.req.json();
    const inputs = createLeadInput.array().max(5_000).parse(Array.isArray(body) ? body : [body]);
    const created = await campaigns.addLeads(scope, c.req.param('id'), inputs);
    return c.json({ items: created, total: created.length }, 201);
  });
}
