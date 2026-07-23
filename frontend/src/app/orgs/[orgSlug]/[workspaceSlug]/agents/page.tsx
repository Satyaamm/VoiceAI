'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Avatar, Button, Card, Flex, Input, Segmented, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { AgentStatusTag } from '@/components/common/StatusTag';
import { useAsync } from '@/hooks/useAsync';
import { agentApi } from '@/lib/api';
import type { Agent, AgentStatus } from '@/lib/contract';
import { formatNumber, formatPercent, formatRelative, formatUsd } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

type StatusFilter = 'all' | AgentStatus;

export default function AgentsPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const state = useAsync(
    () => (workspace ? agentApi.list(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );

  const columns: ColumnsType<Agent> = useMemo(
    () => [
      {
        title: 'Agent',
        dataIndex: 'name',
        key: 'name',
        sorter: (a, b) => a.name.localeCompare(b.name),
        render: (_, agent) => (
          <Flex align="center" gap={10}>
            <Avatar shape="square" size={30} style={{ fontSize: 12, fontWeight: 600 }}>
              {agent.name.slice(0, 2).toUpperCase()}
            </Avatar>
            <Flex vertical>
              <Link href={wsPath(scope, 'agents', agent.id)} style={{ fontWeight: 550 }}>
                {agent.name}
              </Link>
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 340 }}>
                {agent.description}
              </Typography.Text>
            </Flex>
          </Flex>
        ),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: 108,
        render: (_, agent) => <AgentStatusTag status={agent.status} />,
      },
      {
        title: 'Language',
        dataIndex: 'language',
        key: 'language',
        width: 96,
        render: (value: string) => <Typography.Text type="secondary">{value}</Typography.Text>,
      },
      {
        title: 'Calls today',
        key: 'callsToday',
        width: 108,
        align: 'right',
        sorter: (a, b) => a.stats.callsToday - b.stats.callsToday,
        render: (_, agent) => (
          <Link href={wsPath(scope, `calls?agentId=${agent.id}`)} className="tabular">
            {formatNumber(agent.stats.callsToday)}
          </Link>
        ),
      },
      {
        title: 'Success',
        key: 'successRate',
        width: 96,
        align: 'right',
        sorter: (a, b) => a.stats.successRate - b.stats.successRate,
        render: (_, agent) => (
          <Tooltip title="Click to see the calls that didn't resolve">
            <Link href={wsPath(scope, `calls?agentId=${agent.id}&outcome=abandoned`)} className="tabular">
              {formatPercent(agent.stats.successRate, 0)}
            </Link>
          </Tooltip>
        ),
      },
      {
        title: 'p50',
        key: 'p50',
        width: 92,
        align: 'right',
        sorter: (a, b) => a.stats.avgLatencyMs - b.stats.avgLatencyMs,
        render: (_, agent) => <LatencyBadge ms={agent.stats.avgLatencyMs} />,
      },
      {
        title: 'p95',
        key: 'p95',
        width: 92,
        align: 'right',
        sorter: (a, b) => a.stats.p95LatencyMs - b.stats.p95LatencyMs,
        render: (_, agent) => <LatencyBadge ms={agent.stats.p95LatencyMs} />,
      },
      {
        title: 'Cost / call',
        key: 'cost',
        width: 100,
        align: 'right',
        sorter: (a, b) => a.stats.costPerCallUsd - b.stats.costPerCallUsd,
        render: (_, agent) => <span className="tabular">{formatUsd(agent.stats.costPerCallUsd, 3)}</span>,
      },
      {
        title: 'Updated',
        key: 'updated',
        width: 124,
        render: (_, agent) => (
          <Typography.Text type="secondary">
            v{agent.version} · {formatRelative(agent.updatedAt)}
          </Typography.Text>
        ),
      },
    ],
    [scope],
  );

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Every agent in this workspace, with the numbers that decide whether it's working."
        actions={
          canWrite && (
            <Button type="primary" icon={<PlusOutlined />}>
              New agent
            </Button>
          )
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} align="center" wrap style={{ padding: 12 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search agents"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <Segmented<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'live', label: 'Live' },
              { value: 'draft', label: 'Draft' },
              { value: 'paused', label: 'Paused' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </Flex>

        <AsyncBoundary state={state} isEmpty={(agents) => agents.length === 0}>
          {(agents) => {
            const rows = agents.filter(
              (a) =>
                (status === 'all' || a.status === status) &&
                (search === '' ||
                  `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase())),
            );
            return (
              <Table<Agent>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
                scroll={{ x: 1080 }}
              />
            );
          }}
        </AsyncBoundary>
      </Card>
    </>
  );
}
