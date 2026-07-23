'use client';

import { useEffect, useState } from 'react';
import { Flex, Progress, Tooltip, Typography } from 'antd';
import { workspaceApi } from '@/lib/api';
import type { Workspace } from '@/lib/contract';
import { useCurrentScope } from '@/lib/scope';
import { formatUsd } from '@/lib/format';

/**
 * Live burn rate against the workspace's daily cap (docs/12 §3 — spend caps are a
 * hard resource limit, and the burn rate belongs in the chrome, not a billing page).
 */
export function SpendMeter() {
  const { org, workspace } = useCurrentScope();
  const [data, setData] = useState<Workspace | null>(null);

  useEffect(() => {
    if (!org || !workspace) return;
    let live = true;
    workspaceApi
      .list(org.id)
      .then((all) => live && setData(all.find((w) => w.id === workspace.id) ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [org, workspace]);

  if (!data?.spend || data.spendCaps.dailyUsd == null) return null;

  const used = data.spend.todayUsd;
  const cap = data.spendCaps.dailyUsd;
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const status = pct >= 90 ? 'exception' : pct >= 70 ? 'active' : 'normal';

  return (
    <Tooltip
      title={`Daily cap ${formatUsd(cap)} · on breach: ${data.spendCaps.breachAction.replace('_', ' ')}`}
      placement="right"
    >
      <div style={{ marginBottom: 8 }}>
        <Flex justify="space-between" align="baseline">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Spend today
          </Typography.Text>
          <Typography.Text className="tabular" style={{ fontSize: 11 }}>
            {formatUsd(used)}
          </Typography.Text>
        </Flex>
        <Progress percent={pct} size="small" status={status} showInfo={false} />
      </div>
    </Tooltip>
  );
}
