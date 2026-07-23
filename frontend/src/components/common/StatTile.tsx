'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRightOutlined } from '@ant-design/icons';
import { Card, Flex, Skeleton, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }, { clickable }: { clickable: boolean }) => ({
  card: css`
    height: 100%;
    ${clickable
      ? css`
          cursor: pointer;
          transition: border-color ${token.motionDurationMid}, transform ${token.motionDurationMid};
          &:hover {
            border-color: ${token.colorPrimaryBorderHover};
            transform: translateY(-1px);
          }
          &:hover .stat-arrow {
            opacity: 1;
          }
        `
      : ''}
  `,
  label: css`
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
  `,
  value: css`
    font-size: 26px;
    font-weight: 620;
    letter-spacing: -0.025em;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
  `,
  arrow: css`
    opacity: 0;
    transition: opacity ${token.motionDurationMid};
    color: ${token.colorTextTertiary};
  `,
}));

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  /** Every number is a link (docs/07 §Design principles 2) — never a dead-end metric. */
  href?: string;
  tooltip?: string;
  loading?: boolean;
}

export function StatTile({ label, value, hint, tone = 'default', href, tooltip, loading }: StatTileProps) {
  const { styles, theme } = useStyles({ clickable: Boolean(href) });

  const color =
    tone === 'success'
      ? theme.colorSuccess
      : tone === 'warning'
        ? theme.colorWarning
        : tone === 'danger'
          ? theme.colorError
          : undefined;

  const body = (
    <Card className={styles.card} size="small" styles={{ body: { padding: 14 } }}>
      {loading ? (
        <Skeleton active paragraph={false} title={{ width: '60%' }} />
      ) : (
        <>
          <Flex justify="space-between" align="center">
            <span className={styles.label}>{label}</span>
            {href && <ArrowRightOutlined className={`stat-arrow ${styles.arrow}`} />}
          </Flex>
          <div className={styles.value} style={{ color, marginTop: 6 }}>
            {value}
          </div>
          {hint && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {hint}
            </Typography.Text>
          )}
        </>
      )}
    </Card>
  );

  const wrapped = tooltip ? <Tooltip title={tooltip}>{body}</Tooltip> : body;
  return href ? <Link href={href}>{wrapped}</Link> : wrapped;
}
