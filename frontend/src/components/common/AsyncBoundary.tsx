'use client';

import type { ReactNode } from 'react';
import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Flex, Result, Skeleton, Typography } from 'antd';
import { API_URL } from '@/lib/api';
import type { AsyncState } from '@/hooks/useAsync';

/**
 * One loading / error / empty treatment for the whole product, so no screen
 * invents its own. Keeps the "backend isn't up yet" case honest and actionable
 * instead of showing a spinner forever.
 */
export function AsyncBoundary<T>({
  state,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  state: AsyncState<T>;
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { data, loading, error, reload } = state;

  if (loading && data == null) {
    return <>{skeleton ?? <Skeleton active paragraph={{ rows: 6 }} />}</>;
  }

  if (error && data == null) {
    const offline = error.includes('Cannot reach the API');
    return (
      <Result
        icon={<ApiOutlined style={{ opacity: 0.5 }} />}
        title={offline ? 'The control plane isn’t responding' : 'Something went wrong'}
        subTitle={
          offline ? (
            <Flex vertical align="center" gap={4}>
              <span>Expected at {API_URL}</span>
              <Typography.Text code copyable>
                cd backend/control-plane &amp;&amp; npm run dev
              </Typography.Text>
            </Flex>
          ) : (
            error
          )
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={reload}>
            Try again
          </Button>
        }
      />
    );
  }

  if (data == null || (isEmpty && isEmpty(data))) {
    return <>{empty ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing here yet" />}</>;
  }

  return <>{children(data)}</>;
}
