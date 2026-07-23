'use client';

import type { ReactNode } from 'react';
import { Flex, Typography } from 'antd';

/** Consistent page title block. Actions sit right, aligned to the title baseline. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Flex justify="space-between" align="flex-start" gap={16} style={{ marginBottom: 18 }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0, letterSpacing: '-0.02em' }}>
          {title}
        </Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {subtitle}
          </Typography.Text>
        )}
      </div>
      {actions && <Flex gap={8}>{actions}</Flex>}
    </Flex>
  );
}
