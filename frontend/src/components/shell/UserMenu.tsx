'use client';

import { useRouter } from 'next/navigation';
import {
  LogoutOutlined,
  MoonOutlined,
  QuestionCircleOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Dropdown, Flex, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { useUiStore } from '@/stores/ui-store';

export function UserMenu() {
  const router = useRouter();
  const user = useSessionStore((s) => s.session?.user);
  const logOut = useSessionStore((s) => s.logOut);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const { org, workspace } = useCurrentScope();

  if (!user) return null;

  const items: MenuProps['items'] = [
    {
      key: 'identity',
      label: (
        <Flex vertical style={{ padding: '4px 0', maxWidth: 220 }}>
          <Typography.Text strong ellipsis>
            {user.firstName} {user.familyName}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
            {user.email}
          </Typography.Text>
        </Flex>
      ),
      disabled: true,
    },
    { type: 'divider' },
    { key: 'profile', icon: <UserOutlined />, label: 'Account settings' },
    {
      key: 'theme',
      icon: theme === 'dark' ? <SunOutlined /> : <MoonOutlined />,
      label: theme === 'dark' ? 'Light theme' : 'Dark theme',
    },
    { key: 'docs', icon: <QuestionCircleOutlined />, label: 'Documentation' },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Log out', danger: true },
  ];

  const onClick: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'theme') return toggleTheme();
    if (key === 'profile' && org && workspace) {
      return router.push(`/orgs/${org.slug}/${workspace.slug}/settings/account`);
    }
    if (key === 'logout') {
      await logOut();
      router.push('/login');
    }
  };

  return (
    <Dropdown menu={{ items, onClick }} trigger={['click']} placement="bottomRight">
      <Avatar
        size={28}
        src={user.avatarUrl}
        style={{ cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
      >
        {user.firstName[0]}
        {user.familyName[0]}
      </Avatar>
    </Dropdown>
  );
}
