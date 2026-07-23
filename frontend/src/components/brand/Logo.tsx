'use client';

import { Flex, Typography } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }) => ({
  mark: css`
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%);
    display: grid;
    place-items: center;
    flex: none;
  `,
  bars: css`
    display: flex;
    align-items: center;
    gap: 2px;
    height: 13px;
  `,
  bar: css`
    width: 2px;
    border-radius: 2px;
    background: ${token.colorBgContainer};
  `,
  word: css`
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1;
    margin: 0;
  `,
}));

/** Waveform mark — four bars, the product in one glyph. */
export function Logo({ showWordmark = true }: { showWordmark?: boolean }) {
  const { styles } = useStyles();
  const heights = [6, 13, 9, 4];

  return (
    <Flex align="center" gap={9}>
      <div className={styles.mark}>
        <div className={styles.bars}>
          {heights.map((h, i) => (
            <span key={i} className={styles.bar} style={{ height: h }} />
          ))}
        </div>
      </div>
      {showWordmark && (
        <Typography.Text className={styles.word}>VoiceAI</Typography.Text>
      )}
    </Flex>
  );
}
