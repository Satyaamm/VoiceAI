/**
 * Design tokens — the single source of truth for colour, spacing, radius and type.
 *
 * docs/07-ui-stack.md §"The honest tradeoff": type scale, primary colour, radius,
 * table density and spacing rhythm do ~80% of the work of not looking like default
 * antd. Everything visual resolves through here — no component hardcodes a colour.
 *
 * Visual direction: Cartesia-style — near-black / off-white neutrals, one vivid
 * green accent used sparingly, generous radius, tight type.
 */
import type { ThemeConfig } from 'antd';
import { theme } from 'antd';

/** Product palette. Semantic names only — never reference a hex outside this file. */
export const palette = {
  /** Signature green. Light surfaces need the deeper tone for AA contrast. */
  green: '#00A66B',
  greenBright: '#2BE38B',
  greenSoft: 'rgba(0, 166, 107, 0.10)',
  greenSoftDark: 'rgba(61, 227, 155, 0.14)',

  /** Neutrals — warm-tinted near-black and off-white, not pure #000/#fff. */
  ink: '#0F1211',
  inkSoft: '#5A625E',
  paper: '#FAFAF8',
  panel: '#FFFFFF',
  line: '#E7E8E4',

  nightBg: '#0B0D0C',
  nightPanel: '#131614',
  nightElevated: '#191D1B',
  nightLine: '#252A27',

  warning: '#E8A317',
  error: '#E5484D',
  info: '#3B82F6',

  /** Test mode = amber, live mode = green. Used by the header mode toggle. */
  modeTest: '#E8A317',
  modeLive: '#00A66B',
} as const;

/** Latency thresholds (ms) — every latency number in the app colours the same way. */
export const latencyThresholds = { good: 400, warn: 700 } as const;

export const fontFamily =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const fontFamilyCode =
  '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace';

const sharedToken = {
  fontFamily,
  fontFamilyCode,
  // Type scale — 13px base. An operator console reads denser than a marketing page.
  fontSize: 13,
  fontSizeSM: 12,
  fontSizeLG: 15,
  fontSizeXL: 18,
  fontSizeHeading1: 30,
  fontSizeHeading2: 22,
  fontSizeHeading3: 17,
  fontSizeHeading4: 15,
  fontSizeHeading5: 13,
  lineHeight: 1.5715,
  // Radius — softer than antd's 6px default, short of the pill look.
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  borderRadiusXS: 4,
  // Spacing rhythm — 4px grid.
  padding: 16,
  paddingSM: 12,
  paddingXS: 8,
  paddingXXS: 4,
  margin: 16,
  marginSM: 12,
  marginXS: 8,
  controlHeight: 34,
  controlHeightSM: 26,
  controlHeightLG: 40,
  wireframe: false,
  motionDurationMid: '0.15s',
} satisfies ThemeConfig['token'];

/** Component overrides — density is the point (docs/07 "Dense over airy"). */
function componentsFor(dark: boolean): ThemeConfig['components'] {
  return {
    Table: {
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      cellPaddingBlockSM: 6,
      cellPaddingInlineSM: 10,
      headerBorderRadius: 8,
      headerBg: dark ? palette.nightElevated : '#F2F3F0',
      rowHoverBg: dark ? palette.greenSoftDark : palette.greenSoft,
    },
    Layout: {
      headerHeight: 52,
      headerPadding: '0 16px',
      headerBg: dark ? palette.nightPanel : palette.panel,
      siderBg: dark ? palette.nightPanel : palette.panel,
      bodyBg: dark ? palette.nightBg : palette.paper,
    },
    Menu: {
      itemHeight: 34,
      itemMarginInline: 8,
      itemBorderRadius: 6,
      iconMarginInlineEnd: 10,
      itemBg: 'transparent',
      itemSelectedBg: dark ? palette.greenSoftDark : palette.greenSoft,
      itemSelectedColor: dark ? palette.greenBright : palette.green,
    },
    Card: { paddingLG: 16 },
    Statistic: { contentFontSize: 24 },
    Button: { paddingInline: 14, fontWeight: 500, primaryShadow: 'none' },
    Tabs: { horizontalItemPadding: '10px 0', horizontalItemGutter: 24 },
    Descriptions: { itemPaddingBottom: 10 },
    Form: { itemMarginBottom: 18, verticalLabelPadding: '0 0 4px' },
    Segmented: { itemSelectedBg: dark ? palette.nightElevated : '#FFFFFF' },
    Tooltip: { colorBgSpotlight: dark ? '#222724' : 'rgba(15, 18, 17, 0.94)' },
  };
}

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: palette.green,
    colorSuccess: palette.green,
    colorWarning: palette.warning,
    colorError: palette.error,
    colorInfo: palette.info,
    colorLink: palette.green,
    colorText: palette.ink,
    colorTextSecondary: palette.inkSoft,
    colorBgLayout: palette.paper,
    colorBgContainer: palette.panel,
    colorBgElevated: palette.panel,
    colorBorder: palette.line,
    colorBorderSecondary: '#EEEFEB',
  },
  components: componentsFor(false),
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: palette.greenBright,
    colorSuccess: palette.greenBright,
    colorWarning: palette.warning,
    colorError: palette.error,
    colorInfo: palette.info,
    colorLink: palette.greenBright,
    colorBgLayout: palette.nightBg,
    colorBgContainer: palette.nightPanel,
    colorBgElevated: palette.nightElevated,
    colorBorder: palette.nightLine,
    colorBorderSecondary: '#1E2320',
  },
  components: componentsFor(true),
};
