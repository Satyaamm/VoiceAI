'use client';

import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { Logo } from '@/components/brand/Logo';

const useStyles = createStyles(({ token, css }) => ({
  page: css`
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    background: ${token.colorBgContainer};

    @media (max-width: 900px) {
      grid-template-columns: 1fr;
    }
  `,
  left: css`
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 48px;
    @media (max-width: 900px) {
      padding: 32px 24px;
    }
  `,
  form: css`
    width: 100%;
    max-width: 372px;
    margin: 0 auto;
  `,
  right: css`
    position: relative;
    overflow: hidden;
    background:
      radial-gradient(120% 90% at 85% 15%, ${token.colorPrimary}26 0%, transparent 60%),
      radial-gradient(90% 70% at 15% 90%, ${token.colorPrimary}1a 0%, transparent 55%),
      ${token.colorBgLayout};
    border-left: 1px solid ${token.colorBorderSecondary};
    display: flex;
    align-items: center;
    padding: 56px;

    @media (max-width: 900px) {
      display: none;
    }
  `,
  pitch: css`
    max-width: 420px;
    h2 {
      font-size: 32px;
      line-height: 1.15;
      letter-spacing: -0.03em;
      margin: 0 0 14px;
    }
  `,
  stat: css`
    font-variant-numeric: tabular-nums;
    font-size: 26px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: ${token.colorPrimary};
    line-height: 1.1;
  `,
  bars: css`
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 44px;
    margin-bottom: 28px;
  `,
  bar: css`
    width: 4px;
    border-radius: 2px;
    background: linear-gradient(180deg, ${token.colorPrimary} 0%, ${token.colorPrimary}55 100%);
  `,
  brandRow: css`
    margin-bottom: 40px;
  `,
}));

const WAVE = [10, 22, 36, 18, 44, 28, 14, 34, 24, 40, 16, 30, 12, 26, 20, 38, 8, 22, 32, 12];

/**
 * Split auth layout. Left = form, right = the pitch. Marketing-grade polish here
 * is deliberate — it's the first thing anyone sees (docs/09 step 2).
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { styles } = useStyles();

  return (
    <div className={styles.page}>
      <div className={styles.left}>
        <div className={styles.form}>
          <div className={styles.brandRow}>
            <Logo />
          </div>
          <Typography.Title level={2} style={{ marginBottom: subtitle ? 6 : 22 }}>
            {title}
          </Typography.Title>
          {subtitle && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 26 }}>
              {subtitle}
            </Typography.Paragraph>
          )}
          {children}
        </div>
      </div>

      <div className={styles.right}>
        <div className={styles.pitch}>
          <div className={styles.bars} aria-hidden>
            {WAVE.map((h, i) => (
              <span key={i} className={styles.bar} style={{ height: h }} />
            ))}
          </div>
          <Typography.Title level={2}>Voice agents that answer before the pause is awkward.</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>
            Sub-400ms end-of-speech to first audio, a trace viewer that shows every
            millisecond of the pipeline, and compliance that holds up in a security review.
          </Typography.Paragraph>
          <Flex gap={40} style={{ marginTop: 32 }}>
            <div>
              <div className={styles.stat}>320 ms</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                median response
              </Typography.Text>
            </div>
            <div>
              <div className={styles.stat}>60 s</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                signup to first call
              </Typography.Text>
            </div>
            <div>
              <div className={styles.stat}>100k</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                concurrent calls
              </Typography.Text>
            </div>
          </Flex>
        </div>
      </div>
    </div>
  );
}
