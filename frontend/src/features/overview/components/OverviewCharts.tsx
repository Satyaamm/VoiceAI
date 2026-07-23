'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from 'antd';
import { useTheme } from 'antd-style';
import type { OverviewMetrics } from '@/lib/contract';

/* @ant-design/plots pulls in a large canvas runtime — load it client-side only so
   it never lands in the server bundle or blocks first paint. */
const Line = dynamic(() => import('@ant-design/plots').then((m) => m.Line), {
  ssr: false,
  loading: () => <Skeleton active />,
});
const Column = dynamic(() => import('@ant-design/plots').then((m) => m.Column), {
  ssr: false,
  loading: () => <Skeleton active />,
});

const hour = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', hour12: false }) + ':00';

export function LatencyChart({ series }: { series: OverviewMetrics['latencySeries'] }) {
  const token = useTheme();

  const data = series.flatMap((p) => [
    { t: hour(p.t), value: p.p50, metric: 'p50' },
    { t: hour(p.t), value: p.p95, metric: 'p95' },
  ]);

  return (
    <Line
      data={data}
      xField="t"
      yField="value"
      colorField="metric"
      height={252}
      autoFit
      shapeField="smooth"
      scale={{ color: { range: [token.colorPrimary, token.colorWarning] } }}
      axis={{
        y: { title: 'ms', labelFormatter: (v: number) => `${v}` },
        x: { labelAutoHide: true },
      }}
      legend={{ color: { position: 'top', layout: { justifyContent: 'flex-end' } } }}
      tooltip={{ items: [{ channel: 'y', valueFormatter: (v: number) => `${Math.round(v)} ms` }] }}
    />
  );
}

export function VolumeChart({ series }: { series: OverviewMetrics['callVolumeSeries'] }) {
  const token = useTheme();

  const data = series.flatMap((p) => [
    { t: hour(p.t), value: p.inbound, direction: 'inbound' },
    { t: hour(p.t), value: p.outbound, direction: 'outbound' },
  ]);

  return (
    <Column
      data={data}
      xField="t"
      yField="value"
      colorField="direction"
      stack
      height={252}
      autoFit
      scale={{ color: { range: [token.colorPrimary, token.colorInfo] } }}
      axis={{ x: { labelAutoHide: true } }}
      legend={{ color: { position: 'top', layout: { justifyContent: 'flex-end' } } }}
      style={{ radiusTopLeft: 3, radiusTopRight: 3 }}
    />
  );
}
