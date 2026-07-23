/**
 * Development seed data.
 *
 * Deliberately goes through the REAL signup path rather than inserting rows
 * directly. Two reasons:
 *
 *  1. It exercises the auto-provisioning flow on every boot — if the "under 60
 *     seconds to a conversation" journey (docs/11 §A) breaks, the server fails to
 *     start rather than failing silently for the first real user.
 *  2. Seeded data is then indistinguishable from real data, so nothing works in
 *     dev because of a fixture shortcut that production won't have.
 *
 * Seeds a DE org and a US org so residency and compliance divergence is visible
 * from the dashboard immediately.
 */

import type { Container } from './container.js';

export interface SeedResult {
  accounts: Array<{
    email: string;
    orgSlug: string;
    workspaceId: string;
    agentId: string;
    sessionToken: string;
  }>;
}

const ACCOUNTS = [
  { email: 'founder@acme-eu.example', country: 'DE', timezone: 'Europe/Berlin', locale: 'de-DE' },
  { email: 'founder@acme-us.example', country: 'US', timezone: 'America/New_York', locale: 'en-US' },
];

export async function seed(c: Container): Promise<SeedResult> {
  const accounts: SeedResult['accounts'] = [];

  for (const spec of ACCOUNTS) {
    const result = await c.services.auth.signup({
      email: spec.email,
      password: 'dev-password-not-for-production',
      country: spec.country,
      timezone: spec.timezone,
      locale: spec.locale,
    });

    accounts.push({
      email: spec.email,
      orgSlug: result.organization.slug,
      workspaceId: result.workspace.id,
      agentId: result.agent.id,
      sessionToken: result.session.token,
    });

    // Log the compliance posture that was DERIVED, not configured. If these
    // values ever stop diverging by country, the defaults have regressed.
    c.logger.info('seeded account', {
      org: result.organization.slug,
      country: spec.country,
      region: result.workspace.region,
      consentModel: result.workspace.compliance.consentModel,
      retentionDays: result.workspace.compliance.retentionDays,
      requireConsentProof: result.workspace.compliance.requireConsentProof,
      aiDisclosure: result.workspace.compliance.aiDisclosureRequired,
      agent: result.agent.name,
      language: result.agent.language,
    });
  }

  return { accounts };
}
