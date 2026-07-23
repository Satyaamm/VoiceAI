/**
 * v1 — platform metadata, provider health, compliance artefacts.
 *
 * The capabilities endpoint is registry-driven: registering a new provider or
 * strategy makes it appear in the dashboard with no frontend change. That is the
 * payoff for the Registry pattern.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_ } from '../../domain/tenant.js';
import { REGION_OPTIONS } from '../../services/region.js';
import { requirementsFor, checkEligibility } from '../../compliance/provider-eligibility.js';
import type { AuditAction } from '../../compliance/audit-log.js';

export function platformRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /**
   * Capabilities, filtered to what THIS workspace may legally use.
   *
   * An EU-pinned workspace must not be offered a US-only vendor, and a
   * HIPAA workspace must not be offered a non-BAA one. Crucially we return the
   * ineligible ones too, WITH a reason — "why can't I pick Deepgram?" has to be
   * answerable in the UI rather than the option silently missing.
   */
  app.get('/capabilities', async (c) => {
    const scope = c.get('scope');
    const { stt, llm, tts, endpointing, bargeIn } = container.registries;

    let eligibility: Array<{ providerKey: string; eligible: boolean; reasons: unknown[] }> = [];
    if (scope.workspaceId) {
      const ws = await container.services.workspaces.get(scope, scope.workspaceId);
      const req = requirementsFor(ws.region, ws.compliance);
      eligibility = container.compliance.postures.all().map((p) => {
        const result = checkEligibility(p, req);
        return { providerKey: p.key, eligible: result.eligible, reasons: result.reasons };
      });
    }

    return c.json({
      stt: stt.options(),
      llm: llm.options(),
      tts: tts.options(),
      endpointing: endpointing.options(),
      bargeIn: bargeIn.options(),
      regions: REGION_OPTIONS,
      eligibility,
    });
  });

  app.get('/providers/health', (c) =>
    c.json({
      stt: container.executors.stt.states(),
      llm: container.executors.llm.states(),
      tts: container.executors.tts.states(),
    }),
  );

  // docs/14 §3 item 7 — customers ask for this during procurement. Generated from
  // the same postures that gate provider selection, so it cannot drift from what
  // the platform actually enforces.
  app.get('/compliance/subprocessors', (c) =>
    c.json({ items: container.compliance.postures.toSubprocessorTable() }),
  );

  // SOC 2 CC7.2 / HIPAA §164.312(b).
  app.get('/audit', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:members');
    const params = new URL(c.req.url).searchParams;
    const entries = await container.compliance.audit.listFor(scope, {
      workspaceId: params.get('workspaceId') ?? undefined,
      actorId: params.get('actorId') ?? undefined,
      action: (params.get('action') as AuditAction | null) ?? undefined,
      limit: Number(params.get('limit') ?? 100),
    });
    return c.json({ items: entries });
  });

  /** Proves the hash chain is intact. Auditors ask for this; so do incidents. */
  app.get('/audit/verify', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:members');
    return c.json(await container.compliance.audit.verify(scope.orgId));
  });

  return app;
}
