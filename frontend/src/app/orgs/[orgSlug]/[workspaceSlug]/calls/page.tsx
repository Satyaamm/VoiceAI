'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowDownOutlined, ArrowUpOutlined, ExportOutlined, SearchOutlined, WarningFilled } from '@ant-design/icons';
import { Button, Card, Flex, Input, Select, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { CallStatusTag, ModeTag, OutcomeTag } from '@/components/common/StatusTag';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, callApi, type CallFilters } from '@/lib/api';
import type { Call } from '@/lib/contract';
import { formatDuration, formatRelative, formatUsd } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';

const PAGE_SIZE = 50;

function CallsInner() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const params = useSearchParams();

  /* Filters are seeded from the query string so "every number is a link"
     (docs/07 §2) — a stat tile can deep-link straight into the failing subset. */
  const [filters, setFilters] = useState<CallFilters>({
    agentId: params.get('agentId') ?? undefined,
    outcome: params.get('outcome') ?? undefined,
    minLatencyMs: params.get('minLatencyMs') ? Number(params.get('minLatencyMs')) : undefined,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [search, setSearch] = useState('');

  const state = useAsync(
    () =>
      workspace
        ? callApi.list(workspace.id, { ...filters, search: search || undefined })
        : Promise.resolve({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE }),
    [workspace?.id, JSON.stringify(filters), search],
  );

  const agents = useAsync(
    () => (workspace ? agentApi.list(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );

  const columns: ColumnsType<Call> = useMemo(
    () => [
      {
        title: 'Call',
        key: 'id',
        width: 190,
        fixed: 'left',
        render: (_, call) => (
          <Flex vertical>
            <Link href={wsPath(scope, 'calls', call.id)} style={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {call.id}
            </Link>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {formatRelative(call.startedAt)}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: '',
        key: 'direction',
        width: 34,
        render: (_, call) => (
          <Tooltip title={call.direction}>
            {call.direction === 'inbound' ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
          </Tooltip>
        ),
      },
      {
        title: 'Agent',
        dataIndex: 'agentName',
        key: 'agent',
        width: 190,
        render: (name: string, call) => (
          <Link href={wsPath(scope, 'agents', call.agentId)}>
            {name}{' '}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              v{call.agentVersion}
            </Typography.Text>
          </Link>
        ),
      },
      { title: 'Status', key: 'status', width: 118, render: (_, c) => <CallStatusTag status={c.status} /> },
      { title: 'Outcome', key: 'outcome', width: 116, render: (_, c) => <OutcomeTag outcome={c.outcome} /> },
      { title: 'Mode', key: 'mode', width: 84, render: (_, c) => <ModeTag mode={c.mode} /> },
      {
        title: 'Duration',
        key: 'duration',
        width: 92,
        align: 'right',
        render: (_, c) => <span className="tabular">{formatDuration(c.durationSec)}</span>,
      },
      { title: 'Turns', dataIndex: 'turnCount', key: 'turns', width: 74, align: 'right' },
      {
        title: 'p50',
        key: 'p50',
        width: 96,
        align: 'right',
        render: (_, c) => <LatencyBadge ms={c.medianLatencyMs} />,
      },
      {
        title: 'p95',
        key: 'p95',
        width: 96,
        align: 'right',
        render: (_, c) => <LatencyBadge ms={c.p95LatencyMs} />,
      },
      {
        title: 'Cost',
        key: 'cost',
        width: 88,
        align: 'right',
        render: (_, c) => <span className="tabular">{formatUsd(c.costUsd, 3)}</span>,
      },
      {
        title: '',
        key: 'flags',
        width: 44,
        render: (_, c) =>
          c.complianceFlags?.length ? (
            <Tooltip title={c.complianceFlags.join(', ').replace(/_/g, ' ')}>
              <WarningFilled style={{ color: 'var(--ant-color-warning)' }} />
            </Tooltip>
          ) : null,
      },
    ],
    [scope],
  );

  return (
    <>
      <PageHeader
        title="Calls"
        subtitle="Every call, filterable down to the ones that went wrong."
        actions={<Button icon={<ExportOutlined />}>Export CSV</Button>}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} wrap align="center" style={{ padding: 12 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Call ID or number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="Agent"
            style={{ width: 200 }}
            value={filters.agentId}
            onChange={(agentId) => setFilters((f) => ({ ...f, agentId, page: 1 }))}
            options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
          <Select
            allowClear
            placeholder="Outcome"
            style={{ width: 150 }}
            value={filters.outcome}
            onChange={(outcome) => setFilters((f) => ({ ...f, outcome, page: 1 }))}
            options={['resolved', 'escalated', 'abandoned', 'voicemail', 'unknown'].map((v) => ({
              value: v,
              label: v[0]!.toUpperCase() + v.slice(1),
            }))}
          />
          <Select
            allowClear
            placeholder="Mode"
            style={{ width: 120 }}
            value={filters.mode}
            onChange={(mode) => setFilters((f) => ({ ...f, mode, page: 1 }))}
            options={[
              { value: 'test', label: 'Test' },
              { value: 'live', label: 'Live' },
            ]}
          />
          <Select
            allowClear
            placeholder="Latency"
            style={{ width: 168 }}
            value={filters.minLatencyMs}
            onChange={(minLatencyMs) => setFilters((f) => ({ ...f, minLatencyMs, page: 1 }))}
            options={[
              { value: 600, label: 'p95 over 600 ms' },
              { value: 900, label: 'p95 over 900 ms' },
              { value: 1500, label: 'p95 over 1.5 s' },
            ]}
          />
        </Flex>

        <AsyncBoundary state={state} isEmpty={(page) => page.items.length === 0}>
          {(page) => (
            <Table<Call>
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={page.items}
              scroll={{ x: 1400, y: 560 }}
              /* virtual keeps a long call log usable — docs/07 §Call log */
              virtual
              pagination={{
                current: page.page,
                pageSize: page.pageSize,
                total: page.total,
                showSizeChanger: false,
                showTotal: (total) => `${total.toLocaleString()} calls`,
                onChange: (p) => setFilters((f) => ({ ...f, page: p })),
              }}
            />
          )}
        </AsyncBoundary>
      </Card>
    </>
  );
}

export default function CallsPage() {
  return (
    <Suspense fallback={null}>
      <CallsInner />
    </Suspense>
  );
}
