'use client';

import { useParams } from 'next/navigation';
import { AudioOutlined, CloudUploadOutlined } from '@ant-design/icons';
import { Button, Card, Col, Flex, Row, Skeleton, Tabs, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { AgentStatusTag } from '@/components/common/StatusTag';
import {
  PipelineTab,
  PromptTab,
  ToolsTab,
  VersionsTab,
  VoiceTab,
} from '@/features/agents/components/AgentTabs';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, platformApi } from '@/lib/api';
import { formatNumber, formatPercent, formatUsd } from '@/lib/format';
import { useSessionStore } from '@/stores/session-store';

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const canPublish = useSessionStore((s) => s.can('agent:publish'));
  const canTest = useSessionStore((s) => s.can('call:place_test'));

  const state = useAsync(() => agentApi.byId(agentId), [agentId]);
  const caps = useAsync(() => platformApi.capabilities(), []);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(agent) => (
        <>
          <PageHeader
            title={
              <Flex align="center" gap={10}>
                {agent.name}
                <AgentStatusTag status={agent.status} />
                <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
                  v{agent.version}
                </Typography.Text>
              </Flex>
            }
            subtitle={agent.description}
            actions={
              <>
                <Tooltip title={canTest ? 'Talk to this agent in the browser' : 'Your role can’t place test calls'}>
                  <Button icon={<AudioOutlined />} disabled={!canTest}>
                    Test call
                  </Button>
                </Tooltip>
                <Tooltip title={canPublish ? undefined : 'Your role can’t publish to live'}>
                  <Button type="primary" icon={<CloudUploadOutlined />} disabled={!canPublish}>
                    Publish
                  </Button>
                </Tooltip>
              </>
            }
          />

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            {[
              { label: 'Calls today', value: formatNumber(agent.stats.callsToday) },
              { label: 'Success rate', value: formatPercent(agent.stats.successRate, 0) },
              { label: 'p50 latency', value: <LatencyBadge ms={agent.stats.avgLatencyMs} showDot={false} /> },
              { label: 'p95 latency', value: <LatencyBadge ms={agent.stats.p95LatencyMs} showDot={false} /> },
              { label: 'Avg duration', value: `${Math.round(agent.stats.avgDurationSec)}s` },
              { label: 'Cost / call', value: formatUsd(agent.stats.costPerCallUsd, 3) },
            ].map((stat) => (
              <Col key={stat.label} xs={12} sm={8} xl={4}>
                <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {stat.label}
                  </Typography.Text>
                  <div className="tabular" style={{ fontSize: 19, fontWeight: 600, marginTop: 2 }}>
                    {stat.value}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>

          <Tabs
            defaultActiveKey="prompt"
            items={[
              { key: 'prompt', label: 'Prompt', children: <PromptTab agent={agent} editable={canWrite} /> },
              {
                key: 'voice',
                label: 'Voice',
                children: <VoiceTab agent={agent} capabilities={caps.data} editable={canWrite} />,
              },
              {
                key: 'pipeline',
                label: 'Pipeline',
                children: <PipelineTab agent={agent} capabilities={caps.data} editable={canWrite} />,
              },
              { key: 'tools', label: `Tools (${agent.tools.length})`, children: <ToolsTab agent={agent} editable={canWrite} /> },
              { key: 'versions', label: 'Versions', children: <VersionsTab agent={agent} /> },
            ]}
          />
        </>
      )}
    </AsyncBoundary>
  );
}
