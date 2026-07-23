'use client';

import { Alert, Button, Card, Col, Empty, Flex, Row, Skeleton, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '@/components/common/PageHeader';
import { StatTile } from '@/components/common/StatTile';
import { LatencyChart, VolumeChart } from '@/features/overview/components/OverviewCharts';
import { useAsync } from '@/hooks/useAsync';
import { overviewApi } from '@/lib/api';
import { formatMs, formatNumber, formatPercent, formatUsd, gradeLatency } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';

export default function OverviewPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const { data, loading, error, reload } = useAsync(
    () => (workspace ? overviewApi.get(workspace.id) : Promise.resolve(null)),
    [workspace?.id],
  );

  const tone = (ms?: number) =>
    ms == null ? 'default' : ({ good: 'success', warn: 'warning', bad: 'danger' } as const)[gradeLatency(ms)];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={workspace ? `${workspace.name} · ${workspace.region}` : undefined}
        actions={
          <Button icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            Refresh
          </Button>
        }
      />

      {error && (
        <Alert
          type="error"
          showIcon
          message="Couldn't load metrics"
          description={error}
          action={
            <Button size="small" onClick={reload}>
              Retry
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Row gutter={[12, 12]}>
        {[
          {
            label: 'Active calls',
            value: data ? formatNumber(data.activeCalls) : '—',
            hint: data ? `peak ${formatNumber(data.concurrentPeak)} today` : undefined,
            href: wsPath(scope, 'calls?status=active'),
          },
          {
            label: 'Calls today',
            value: data ? formatNumber(data.callsToday) : '—',
            href: wsPath(scope, 'calls'),
          },
          {
            label: 'p50 latency',
            value: data ? formatMs(data.medianLatencyMs) : '—',
            hint: 'end of speech → first audio',
            tone: tone(data?.medianLatencyMs),
            href: wsPath(scope, 'analytics'),
          },
          {
            label: 'p95 latency',
            value: data ? formatMs(data.p95LatencyMs) : '—',
            hint: 'the tail your callers feel',
            tone: tone(data?.p95LatencyMs),
            href: wsPath(scope, 'calls?minLatencyMs=600'),
          },
          {
            label: 'Success rate',
            value: data ? formatPercent(data.successRate) : '—',
            hint: data ? `see the ${formatPercent(1 - data.successRate)} that failed` : undefined,
            href: wsPath(scope, 'calls?outcome=abandoned'),
          },
          {
            label: 'Cost today',
            value: data ? formatUsd(data.costTodayUsd) : '—',
            href: wsPath(scope, 'settings/billing'),
          },
        ].map((tile) => (
          <Col key={tile.label} xs={12} sm={8} xl={4}>
            <StatTile {...tile} loading={loading && !data} tone={tile.tone as never} />
          </Col>
        ))}
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title="Latency"
            extra={<Tag bordered={false}>last 24h</Tag>}
            styles={{ body: { height: 288 } }}
          >
            {loading && !data ? (
              <Skeleton active />
            ) : data ? (
              <LatencyChart series={data.latencySeries} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            size="small"
            title="Call volume"
            extra={<Tag bordered={false}>last 24h</Tag>}
            styles={{ body: { height: 288 } }}
          >
            {loading && !data ? (
              <Skeleton active />
            ) : data ? (
              <VolumeChart series={data.callVolumeSeries} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data" />
            )}
          </Card>
        </Col>
      </Row>

      <Flex style={{ marginTop: 12 }} />
    </>
  );
}
