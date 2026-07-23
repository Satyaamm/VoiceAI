'use client';

/**
 * Route scope helpers. `/orgs/[orgSlug]/[workspaceSlug]/...` — the URL is the
 * single source of truth for which org/workspace you're looking at
 * (docs/10 §Scoping rules 3).
 *
 * Naming note: docs/09 and docs/10 say "project"; docs/12 renamed the second
 * level to **Workspace** and `contract.ts` (the source of truth) follows that.
 * Routes therefore read `/orgs/acme/collections`.
 */
import { useParams } from 'next/navigation';
import { useSessionStore } from '@/stores/session-store';

export interface Scope {
  orgSlug: string;
  workspaceSlug: string;
}

export function useScope(): Scope {
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  return {
    orgSlug: params?.orgSlug ?? '',
    workspaceSlug: params?.workspaceSlug ?? '',
  };
}

/** The org/workspace the URL points at, resolved against the loaded session. */
export function useCurrentScope() {
  const { orgSlug, workspaceSlug } = useScope();
  const session = useSessionStore((s) => s.session);
  const org = session?.organizations.find((o) => o.slug === orgSlug) ?? null;
  const workspace =
    session?.workspaces.find((w) => w.orgId === org?.id && w.slug === workspaceSlug) ?? null;
  const workspacesInOrg = session?.workspaces.filter((w) => w.orgId === org?.id) ?? [];
  return { org, workspace, workspacesInOrg, orgSlug, workspaceSlug };
}

/** Build a scoped path: `wsPath({orgSlug, workspaceSlug}, 'agents')`. */
export function wsPath(scope: Scope, ...segments: string[]): string {
  return ['/orgs', scope.orgSlug, scope.workspaceSlug, ...segments].join('/');
}
