'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ApartmentOutlined, PlusOutlined } from '@ant-design/icons';
import { Avatar, Button, Divider, Flex, Select, Tag, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

const useStyles = createStyles(({ token, css }) => ({
  select: css`
    min-width: 168px;
    .ant-select-selector {
      background: ${token.colorFillQuaternary} !important;
      border-color: transparent !important;
    }
  `,
  slash: css`
    color: ${token.colorTextQuaternary};
    user-select: none;
  `,
  footer: css`
    padding: 4px;
  `,
  avatar: css`
    background: ${token.colorPrimary};
    font-size: 10px;
    font-weight: 600;
  `,
}));

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

/** Org switcher + workspace switcher. Changing either navigates — the URL owns scope. */
export function ScopeSwitchers() {
  const { styles } = useStyles();
  const router = useRouter();
  const session = useSessionStore((s) => s.session);
  const { org, workspace, workspacesInOrg } = useCurrentScope();

  const orgOptions = useMemo(
    () =>
      (session?.organizations ?? []).map((o) => ({
        value: o.slug,
        label: (
          <Flex align="center" gap={8}>
            <Avatar size={18} shape="square" className={styles.avatar}>
              {initials(o.name)}
            </Avatar>
            <span>{o.name}</span>
          </Flex>
        ),
        searchText: o.name,
      })),
    [session?.organizations, styles.avatar],
  );

  const wsOptions = useMemo(
    () =>
      workspacesInOrg.map((w) => ({
        value: w.slug,
        label: (
          <Flex align="center" justify="space-between" gap={8}>
            <span>{w.name}</span>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {w.region}
            </Tag>
          </Flex>
        ),
        searchText: w.name,
      })),
    [workspacesInOrg],
  );

  /* Progressive disclosure (docs/11 §C): a solo user with one workspace never
     sees the concept at all. It appears the moment a second one exists. */
  const showWorkspaceSwitcher = workspacesInOrg.length > 1;

  const goOrg = (slug: string) => {
    const nextOrg = session?.organizations.find((o) => o.slug === slug);
    const firstWs = session?.workspaces.find((w) => w.orgId === nextOrg?.id);
    router.push(firstWs ? `/orgs/${slug}/${firstWs.slug}` : `/orgs/${slug}`);
  };

  return (
    <Flex align="center" gap={6}>
      <Select
        className={styles.select}
        size="small"
        variant="filled"
        value={org?.slug}
        options={orgOptions}
        onChange={goOrg}
        showSearch
        optionFilterProp="searchText"
        popupRender={(menu) => (
          <>
            {menu}
            <Divider style={{ margin: '4px 0' }} />
            <div className={styles.footer}>
              <Button type="text" size="small" block icon={<PlusOutlined />} style={{ textAlign: 'left' }}>
                New organization
              </Button>
            </div>
          </>
        )}
      />

      {showWorkspaceSwitcher && (
        <>
          <Typography.Text className={styles.slash}>/</Typography.Text>
          <Select
            className={styles.select}
            size="small"
            variant="filled"
            value={workspace?.slug}
            options={wsOptions}
            onChange={(slug) => router.push(`/orgs/${org?.slug}/${slug}`)}
            showSearch
            optionFilterProp="searchText"
            suffixIcon={<ApartmentOutlined />}
            popupRender={(menu) => (
              <>
                {menu}
                <Divider style={{ margin: '4px 0' }} />
                <div className={styles.footer}>
                  <Button
                    type="text"
                    size="small"
                    block
                    icon={<PlusOutlined />}
                    style={{ textAlign: 'left' }}
                    onClick={() => router.push(`/orgs/${org?.slug}/new-workspace`)}
                  >
                    New workspace
                  </Button>
                </div>
              </>
            )}
          />
        </>
      )}
    </Flex>
  );
}
