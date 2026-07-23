'use client';

import { Segmented, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import { App } from 'antd';
import { sessionApi } from '@/lib/api';
import type { Mode } from '@/lib/contract';
import { palette } from '@/theme/tokens';
import { useUiStore } from '@/stores/ui-store';

const useStyles = createStyles(({ token, css }, { mode }: { mode: Mode }) => {
  const accent = mode === 'test' ? palette.modeTest : palette.modeLive;
  return {
    wrap: css`
      /* The whole control is tinted by the active mode — you can never mistake
         which one you're in from across a room (docs/10 §Test/live mode). */
      background: ${token.colorFillQuaternary};
      border: 1px solid ${accent}55;
      border-radius: ${token.borderRadius}px;
      padding: 1px;

      .ant-segmented-item-selected {
        background: ${accent}22;
        color: ${accent};
        font-weight: 600;
      }
    `,
    dot: css`
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: ${accent};
      margin-right: 6px;
      vertical-align: middle;
    `,
  };
});

/**
 * Stripe-style test/live toggle, persisted per workspace. Test mode = browser
 * and test numbers only, no PSTN spend — a safety control, not just DX.
 */
export function ModeToggle({ workspaceId }: { workspaceId: string | undefined }) {
  const mode = useUiStore((s) => s.getMode(workspaceId));
  const setMode = useUiStore((s) => s.setMode);
  const { styles } = useStyles({ mode });
  const { message } = App.useApp();

  if (!workspaceId) return null;

  const onChange = async (next: string | number) => {
    const value = next as Mode;
    setMode(workspaceId, value);
    try {
      await sessionApi.setMode(workspaceId, value);
    } catch {
      message.error('Could not switch mode — reverting.');
      setMode(workspaceId, mode);
      return;
    }
    if (value === 'live') message.warning('Live mode — calls now use real telephony and real spend.');
  };

  return (
    <Tooltip
      title={
        mode === 'test'
          ? 'Test mode — browser and test numbers only. No PSTN spend.'
          : 'Live mode — real telephony, real spend.'
      }
    >
      <Segmented
        className={styles.wrap}
        size="small"
        value={mode}
        onChange={onChange}
        options={[
          { value: 'test', label: <span><i className={styles.dot} />Test</span> },
          { value: 'live', label: <span><i className={styles.dot} />Live</span> },
        ]}
      />
    </Tooltip>
  );
}
