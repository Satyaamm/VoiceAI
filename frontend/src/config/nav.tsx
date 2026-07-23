'use client';

import {
  ApiOutlined,
  AppstoreOutlined,
  AreaChartOutlined,
  DashboardOutlined,
  PhoneOutlined,
  RobotOutlined,
  SettingOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { Permission } from '@/lib/contract';

export interface NavItem {
  /** Path segment under /orgs/[orgSlug]/[workspaceSlug]; '' is the overview. */
  segment: string;
  label: string;
  icon: ReactNode;
  /** Hidden entirely when the user lacks this permission. */
  permission?: Permission;
  group?: string;
}

/** Sidebar navigation — order matters, this is the daily path through the product. */
export const NAV_ITEMS: NavItem[] = [
  { segment: '', label: 'Overview', icon: <DashboardOutlined />, group: 'Operate' },
  { segment: 'agents', label: 'Agents', icon: <RobotOutlined />, permission: 'agent:read', group: 'Operate' },
  { segment: 'calls', label: 'Calls', icon: <PhoneOutlined />, permission: 'call:read', group: 'Operate' },
  { segment: 'campaigns', label: 'Campaigns', icon: <AppstoreOutlined />, permission: 'campaign:manage', group: 'Operate' },
  { segment: 'numbers', label: 'Numbers', icon: <SoundOutlined />, permission: 'number:manage', group: 'Operate' },
  { segment: 'analytics', label: 'Analytics', icon: <AreaChartOutlined />, permission: 'call:read', group: 'Analyze' },
  { segment: 'keys', label: 'API keys', icon: <ApiOutlined />, permission: 'apikey:manage', group: 'Administer' },
  { segment: 'settings', label: 'Settings', icon: <SettingOutlined />, group: 'Administer' },
];

export const NAV_GROUPS = ['Operate', 'Analyze', 'Administer'] as const;
