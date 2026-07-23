'use client';

import { useState } from 'react';
import {
  ApiOutlined,
  BranchesOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Slider,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import type { Agent, PlatformCapabilities, ToolConfig } from '@/lib/contract';
import { formatMs } from '@/lib/format';

const useStyles = createStyles(({ token, css }) => ({
  editor: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.65;
    min-height: 420px;
    background: ${token.colorFillQuaternary};
    tab-size: 2;
  `,
  gutter: css`
    color: ${token.colorTextQuaternary};
    font-size: 11px;
  `,
  hint: css`
    color: ${token.colorTextTertiary};
    font-size: 12px;
  `,
}));

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function PromptTab({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { styles } = useStyles();
  const [value, setValue] = useState(agent.prompt);
  const dirty = value !== agent.prompt;

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={17}>
        <Card
          size="small"
          title="System prompt"
          extra={
            <Flex align="center" gap={10}>
              <span className={styles.gutter}>
                {value.length.toLocaleString()} chars · ~{Math.ceil(value.length / 3.8).toLocaleString()} tokens
              </span>
              {dirty && (
                <Button size="small" type="primary" ghost>
                  Save draft
                </Button>
              )}
            </Flex>
          }
        >
          {/* CodeMirror 6 replaces this once prompt editing needs syntax awareness
              (docs/07 §What antd does not replace). The contract is the same. */}
          <Input.TextArea
            className={styles.editor}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            readOnly={!editable}
            autoSize={{ minRows: 18, maxRows: 40 }}
            spellCheck={false}
          />
        </Card>
      </Col>

      <Col xs={24} xl={7}>
        <Flex vertical gap={12}>
          <Card size="small" title="Prompt hygiene">
            <Flex vertical gap={10}>
              {[
                { ok: value.includes('#'), text: 'Sectioned with headings' },
                { ok: /never|do not|don’t/i.test(value), text: 'States what not to do' },
                { ok: value.length < 6000, text: 'Under 6,000 characters' },
                { ok: /tool|function/i.test(value), text: 'Tells the model when to use tools' },
              ].map((check) => (
                <Flex key={check.text} align="center" gap={8}>
                  <Tag color={check.ok ? 'green' : 'default'} bordered={false} style={{ marginInlineEnd: 0 }}>
                    {check.ok ? 'ok' : 'check'}
                  </Tag>
                  <span className={styles.hint}>{check.text}</span>
                </Flex>
              ))}
            </Flex>
          </Card>

          <Alert
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
            message="Prefix caching"
            description="Keep volatile content (names, balances) at the end. A stable prefix is what makes TTFT land under 100ms."
          />
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export function VoiceTab({
  agent,
  capabilities,
  editable,
}: {
  agent: Agent;
  capabilities: PlatformCapabilities | null;
  editable: boolean;
}) {
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={12}>
        <Card size="small" title="Voice">
          <Form layout="vertical" initialValues={agent.voice} disabled={!editable}>
            <Form.Item name="providerKey" label="Provider">
              <Select
                options={(capabilities?.tts ?? []).map((o) => ({
                  value: o.value,
                  label: `${o.label}${o.metadata.ttfbMs ? ` · ${o.metadata.ttfbMs}ms TTFB` : ''}`,
                }))}
              />
            </Form.Item>
            <Form.Item name="voiceId" label="Voice">
              <Select
                showSearch
                options={[{ value: agent.voice.voiceId, label: agent.voice.voiceId }]}
                suffixIcon={<SoundOutlined />}
              />
            </Form.Item>
            <Form.Item name="speed" label="Speaking rate">
              <Slider min={0.6} max={1.6} step={0.05} marks={{ 0.6: 'slow', 1: 'natural', 1.6: 'fast' }} />
            </Form.Item>
            <Form.Item
              name="register"
              label="Register"
              tooltip="Getting du/Sie or tu/vous wrong is a real error in DE/FR (docs/13 §4)."
            >
              <Select
                allowClear
                placeholder="Not applicable for this language"
                options={[
                  { value: 'formal', label: 'Formal (Sie / vous)' },
                  { value: 'informal', label: 'Informal (du / tu)' },
                ]}
              />
            </Form.Item>
            <Button icon={<PlayCircleOutlined />} disabled={false}>
              Preview voice
            </Button>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={12}>
        <Card
          size="small"
          title="Pronunciation lexicon"
          extra={<Typography.Text type="secondary">Per-tenant overrides</Typography.Text>}
        >
          <Table
            size="small"
            rowKey="term"
            pagination={false}
            dataSource={agent.voice.lexicon}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No overrides. Add one when the agent mispronounces a brand or product name."
                />
              ),
            }}
            columns={[
              { title: 'Term', dataIndex: 'term' },
              { title: 'Says it as', dataIndex: 'pronunciation' },
            ]}
          />
          {editable && (
            <Button size="small" type="dashed" block style={{ marginTop: 10 }}>
              Add pronunciation
            </Button>
          )}
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function PipelineTab({
  agent,
  capabilities,
  editable,
}: {
  agent: Agent;
  capabilities: PlatformCapabilities | null;
  editable: boolean;
}) {
  const { styles } = useStyles();
  const p = agent.pipeline;

  const stages = [
    { key: 'stt', label: 'Speech to text', value: p.sttProvider, budget: 120 },
    { key: 'endpoint', label: 'Endpointing', value: p.endpointingStrategy, budget: 94 },
    { key: 'llm', label: 'LLM', value: `${p.llmProvider} · ${p.llmModel}`, budget: 88 },
    { key: 'tts', label: 'Text to speech', value: p.ttsProvider, budget: 112 },
  ];

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Pipeline">
          <Form layout="vertical" initialValues={p} disabled={!editable}>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="sttProvider" label="Speech to text">
                  <Select options={(capabilities?.stt ?? []).map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="ttsProvider" label="Text to speech">
                  <Select options={(capabilities?.tts ?? []).map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="llmModel" label="Model">
                  <Select options={(capabilities?.llm ?? []).map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="endpointingStrategy"
                  label="Endpointing"
                  tooltip="Semantic endpointing predicts end-of-turn from meaning rather than silence — the single biggest lever on perceived latency."
                >
                  <Select
                    options={(capabilities?.endpointing ?? []).map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="bargeInStrategy"
                  label="Barge-in"
                  tooltip="Target-speaker gating ignores TV noise and background voices."
                >
                  <Select options={(capabilities?.bargeIn ?? []).map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="temperature" label="Temperature">
                  <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="maxTokens" label="Max tokens">
                  <InputNumber min={50} max={2000} step={50} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="speculativePrefill"
                  label="Speculative prefill"
                  valuePropName="checked"
                  tooltip="Start the LLM before the caller finishes speaking (docs/02). Costs tokens, saves ~80ms."
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="fillerEnabled" label="Filler words" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card size="small" title="Latency budget" extra={<Tag bordered={false}>target 400 ms</Tag>}>
          <Flex vertical gap={12}>
            {stages.map((stage) => (
              <div key={stage.key}>
                <Flex justify="space-between" align="baseline">
                  <Typography.Text>{stage.label}</Typography.Text>
                  <Typography.Text className="tabular" type="secondary">
                    {formatMs(stage.budget)}
                  </Typography.Text>
                </Flex>
                <Tooltip title={stage.value}>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 3,
                      marginTop: 4,
                      background: `linear-gradient(90deg, currentColor ${(stage.budget / 420) * 100}%, transparent 0)`,
                      opacity: 0.35,
                    }}
                  />
                </Tooltip>
                <span className={styles.hint}>{stage.value}</span>
              </div>
            ))}
          </Flex>
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function ToolsTab({ agent, editable }: { agent: Agent; editable: boolean }) {
  return (
    <Card
      size="small"
      title="Tools"
      extra={
        editable && (
          <Button size="small" icon={<ApiOutlined />}>
            Add tool
          </Button>
        )
      }
    >
      <Table<ToolConfig>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={agent.tools}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No tools. Add one when the agent needs to look something up mid-call."
            />
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: 'Description', dataIndex: 'description' },
          {
            title: 'Endpoint',
            dataIndex: 'endpoint',
            render: (v: string, tool) => (
              <Flex gap={6} align="center">
                <Tag bordered={false}>{tool.method}</Tag>
                <Typography.Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
                  {v}
                </Typography.Text>
              </Flex>
            ),
          },
          {
            title: 'Timeout',
            dataIndex: 'timeoutMs',
            width: 96,
            align: 'right',
            render: (v: number) => (
              <Tooltip title="A tool slower than this is a dead-air risk — the agent should say something first.">
                <span className="tabular">{formatMs(v)}</span>
              </Tooltip>
            ),
          },
          {
            title: '',
            key: 'test',
            width: 80,
            render: () => (
              <Button size="small" type="text" icon={<ExperimentOutlined />}>
                Test
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function VersionsTab({ agent }: { agent: Agent }) {
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Version history" extra={<Tag bordered={false}>immutable</Tag>}>
          <Timeline
            items={Array.from({ length: Math.min(agent.version, 6) }, (_, i) => {
              const version = agent.version - i;
              return {
                color: i === 0 ? 'green' : 'gray',
                children: (
                  <Flex vertical gap={2}>
                    <Flex align="center" gap={8}>
                      <Typography.Text strong>v{version}</Typography.Text>
                      {i === 0 && (
                        <Tag color="green" bordered={false}>
                          current
                        </Tag>
                      )}
                    </Flex>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Published from the agent editor.
                    </Typography.Text>
                    <Flex gap={8} style={{ marginTop: 4 }}>
                      <Button size="small" icon={<BranchesOutlined />}>
                        Diff vs current
                      </Button>
                      {i !== 0 && <Button size="small">Roll back</Button>}
                    </Flex>
                  </Flex>
                ),
              };
            })}
          />
        </Card>
      </Col>
      <Col xs={24} xl={10}>
        <Card size="small" title="Current configuration">
          <Descriptions column={1} size="small" bordered items={[
            { key: 'lang', label: 'Language', children: agent.language },
            { key: 'model', label: 'Model', children: agent.pipeline.llmModel },
            { key: 'stt', label: 'STT', children: agent.pipeline.sttProvider },
            { key: 'tts', label: 'TTS', children: agent.pipeline.ttsProvider },
            { key: 'endpoint', label: 'Endpointing', children: agent.pipeline.endpointingStrategy },
            { key: 'tools', label: 'Tools', children: agent.tools.length },
          ]} />
        </Card>
      </Col>
    </Row>
  );
}
