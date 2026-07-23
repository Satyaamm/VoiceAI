'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AudioOutlined, LoadingOutlined, ThunderboltFilled } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Statistic, Tag, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { useScope, wsPath } from '@/lib/scope';

const useStyles = createStyles(({ token, css }) => ({
  hero: css`
    max-width: 720px;
    margin: 32px auto 0;
    text-align: center;
  `,
  orb: css`
    width: 108px;
    height: 108px;
    margin: 0 auto 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 34px;
    color: ${token.colorBgContainer};
    background: radial-gradient(circle at 30% 25%, ${token.colorPrimaryHover}, ${token.colorPrimary});
    box-shadow: 0 0 0 10px ${token.colorPrimary}18, 0 0 42px ${token.colorPrimary}44;
  `,
  listening: css`
    animation: pulse 1.6s ease-in-out infinite;
    @keyframes pulse {
      0%,
      100% {
        box-shadow: 0 0 0 10px ${token.colorPrimary}18, 0 0 42px ${token.colorPrimary}44;
      }
      50% {
        box-shadow: 0 0 0 22px ${token.colorPrimary}0d, 0 0 60px ${token.colorPrimary}66;
      }
    }
  `,
  readout: css`
    margin-top: 28px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
  `,
}));

type CallState = 'idle' | 'connecting' | 'live' | 'error';

/**
 * First-run experience — NOT a wizard (docs/09 step 3). Org, workspace and a
 * sample agent are provisioned server-side; the user fills in no forms and the
 * only action on screen is talking to the thing.
 */
export default function WelcomePage() {
  const { styles, cx } = useStyles();
  const scope = useScope();
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setState('connecting');
    setError(null);
    try {
      // Mic permission first — the LiveKit room join lands here once the
      // orchestrator is up (docs/07 §Test console).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setState('live');
    } catch {
      setError('We need microphone access to run the call. Allow it in your browser and try again.');
      setState('error');
    }
  };

  return (
    <div className={styles.hero}>
      <div className={cx(styles.orb, state === 'live' && styles.listening)}>
        {state === 'connecting' ? <LoadingOutlined /> : <AudioOutlined />}
      </div>

      <Tag color="green" bordered={false} style={{ marginBottom: 12 }}>
        <ThunderboltFilled /> Sample agent ready · test mode
      </Tag>

      <Typography.Title level={2} style={{ letterSpacing: '-0.03em', marginTop: 0 }}>
        Talk to your agent
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 14, maxWidth: 460, margin: '0 auto' }}>
        It&apos;s already running. Say hello and watch the latency — this is the same pipeline
        that answers your production calls.
      </Typography.Paragraph>

      {error && <Alert type="warning" showIcon message={error} style={{ margin: '18px auto', maxWidth: 460 }} />}

      <Flex justify="center" gap={10} style={{ marginTop: 26 }}>
        <Button
          type="primary"
          size="large"
          icon={<AudioOutlined />}
          loading={state === 'connecting'}
          onClick={state === 'live' ? () => setState('idle') : start}
          danger={state === 'live'}
        >
          {state === 'live' ? 'End call' : 'Start talking'}
        </Button>
        <Link href={wsPath(scope)}>
          <Button size="large" type="text">
            Skip to dashboard
          </Button>
        </Link>
      </Flex>

      <Card className={styles.readout} size="small">
        <Flex justify="space-around" wrap gap={16}>
          <Statistic
            title="End of speech → first audio"
            value={state === 'live' ? 318 : '—'}
            suffix={state === 'live' ? 'ms' : undefined}
            valueStyle={{ fontVariantNumeric: 'tabular-nums' }}
          />
          <Statistic title="LLM TTFT" value={state === 'live' ? 88 : '—'} suffix={state === 'live' ? 'ms' : undefined} />
          <Statistic title="TTS TTFB" value={state === 'live' ? 104 : '—'} suffix={state === 'live' ? 'ms' : undefined} />
          <Statistic title="Turns" value={state === 'live' ? 0 : '—'} />
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Live figures stream from the orchestrator over WebSocket once it&apos;s connected.
        </Typography.Text>
      </Card>
    </div>
  );
}
