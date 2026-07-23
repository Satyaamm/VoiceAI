/**
 * Entrypoint.
 *
 * Real authentication: sessions and API keys resolve through
 * `createPrincipalResolver`. The dev header shortcut is gone — `x-org-slug` was
 * only ever scaffolding, and leaving an unauthenticated bypass in a codebase that
 * claims SOC 2 controls would be indefensible.
 */

import { serve } from '@hono/node-server';

import { createContainer } from './container.js';
import { createServer } from './api/index.js';
import { seed } from './seed.js';
import { createPrincipalResolver } from './services/principal-resolver.js';
import { registerProviders } from './providers/registration.js';
import type { FactoryContext, SecretResolver } from './core/patterns/factory.js';

const PORT = Number(process.env.PORT ?? 3101);
const REGION = process.env.REGION ?? 'us-east';

/**
 * Dev secret resolver. Production swaps this for Vault or a cloud KMS — provider
 * factories never read process.env directly, which is what makes that swap a
 * one-line change.
 */
const envSecrets: SecretResolver = {
  async get(name: string) {
    const value = process.env[name];
    if (!value) throw new Error(`missing secret: ${name}`);
    return value;
  },
};

async function main() {
  const container = createContainer();

  const factoryContext: FactoryContext = {
    secrets: envSecrets,
    region: REGION,
    logger: container.logger,
  };

  // Real adapters register on top of the mocks. Any provider whose credential is
  // absent is skipped with a warning, so a dev box boots on mocks alone.
  const attempted = await registerProviders(container.registries, factoryContext);
  const live = attempted.filter((r) => r.registered);
  container.logger.info('provider startup', {
    // Report what ACTUALLY registered, not what was attempted — a boot log that
    // overstates capability is how you discover in production that every call
    // has been running on mocks.
    live: live.map((r) => r.key),
    skipped: attempted.filter((r) => !r.registered).map((r) => r.key),
    usingMocksOnly: live.length === 0,
  });

  // Development fixtures. Skipped entirely in production.
  if (process.env.NODE_ENV !== 'production' && process.env.SEED !== '0') {
    await seed(container);
  }

  const app = createServer({
    container,
    resolvePrincipal: createPrincipalResolver({
      auth: container.services.auth,
      apiKeys: container.services.apiKeys,
      memberships: container.repositories.memberships,
    }),
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    container.logger.info('control-plane listening', {
      port: info.port,
      region: REGION,
      hint: `curl -X POST localhost:${info.port}/auth/signup -H 'content-type: application/json' -d '{"email":"you@acme.com","password":"correct-horse-battery"}'`,
    });
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
