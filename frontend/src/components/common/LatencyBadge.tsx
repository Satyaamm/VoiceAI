'use client';

import { Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import { gradeLatency, type LatencyGrade } from '@/lib/format';
import { latencyThresholds } from '@/theme/tokens';

const useStyles = createStyles(({ token, css }, { grade }: { grade: LatencyGrade }) => {
  const color =
    grade === 'good' ? token.colorSuccess : grade === 'warn' ? token.colorWarning : token.colorError;
  return {
    badge: css`
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-variant-numeric: tabular-nums;
      font-weight: 550;
      color: ${color};
      white-space: nowrap;
    `,
    dot: css`
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: ${color};
      flex: none;
    `,
  };
});

/**
 * Latency is the product (docs/07 §Design principles 1) — so it gets one
 * consistent visual treatment everywhere it appears, with the same thresholds.
 */
export function LatencyBadge({
  ms,
  label,
  showDot = true,
}: {
  ms: number;
  label?: string;
  showDot?: boolean;
}) {
  const grade = gradeLatency(ms);
  const { styles } = useStyles({ grade });

  return (
    <Tooltip
      title={
        label ??
        `end of speech → first audio · good ≤ ${latencyThresholds.good}ms, watch ≤ ${latencyThresholds.warn}ms`
      }
    >
      <span className={styles.badge}>
        {showDot && <i className={styles.dot} />}
        {Math.round(ms)} ms
      </span>
    </Tooltip>
  );
}
