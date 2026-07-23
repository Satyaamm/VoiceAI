'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Flex, Spin } from 'antd';
import { useSessionStore } from '@/stores/session-store';

/** Entry point — send people to their last scope, or to log in. */
export default function RootPage() {
  const router = useRouter();
  const { status, session, load } = useSessionStore();

  useEffect(() => {
    if (status === 'idle') void load();
    if (status === 'anonymous') router.replace('/login');
    if (status === 'authenticated' && session) {
      const org = session.organizations.find((o) => o.id === session.currentOrgId) ?? session.organizations[0];
      const ws =
        session.workspaces.find((w) => w.id === session.currentWorkspaceId) ??
        session.workspaces.find((w) => w.orgId === org?.id);
      router.replace(org && ws ? `/orgs/${org.slug}/${ws.slug}` : '/login');
    }
  }, [status, session, load, router]);

  return (
    <Flex align="center" justify="center" style={{ minHeight: '100vh' }}>
      <Spin size="large" />
    </Flex>
  );
}
