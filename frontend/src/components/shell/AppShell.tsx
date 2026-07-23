'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Layout, Skeleton } from 'antd';
import { createStyles } from 'antd-style';
import { useSessionStore } from '@/stores/session-store';
import { AppHeader } from './AppHeader';
import { SideNav } from './SideNav';

const useStyles = createStyles(({ token, css }) => ({
  content: css`
    padding: 20px 24px 40px;
    max-width: 1560px;
    width: 100%;
    margin: 0 auto;
  `,
  loading: css`
    padding: 48px;
    max-width: 900px;
    margin: 0 auto;
  `,
  layout: css`
    min-height: 100vh;
    background: ${token.colorBgLayout};
  `,
}));

/** Sider + header + body. Every authenticated route renders inside this. */
export function AppShell({ children }: { children: ReactNode }) {
  const { styles } = useStyles();
  const router = useRouter();
  const status = useSessionStore((s) => s.status);
  const load = useSessionStore((s) => s.load);

  useEffect(() => {
    if (status === 'idle') void load();
    if (status === 'anonymous') router.replace('/login');
  }, [status, load, router]);

  return (
    <Layout hasSider className={styles.layout}>
      <SideNav />
      <Layout>
        <AppHeader />
        <Layout.Content className={styles.content}>
          {status === 'authenticated' ? (
            children
          ) : (
            <div className={styles.loading}>
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
