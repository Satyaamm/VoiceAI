'use client';

import { App as AntApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import { ThemeProvider as AntdStyleProvider } from 'antd-style';
import { useEffect, type ReactNode } from 'react';
import { useUiStore } from '@/stores/ui-store';
import { darkTheme, lightTheme, palette } from './tokens';

/**
 * Wraps the app in the antd theme. Light/dark comes from the persisted UI store
 * (`theme.darkAlgorithm`), and `antd-style`'s provider is nested inside so
 * `createStyles` sees the same tokens.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useUiStore((s) => s.theme);
  const config = mode === 'dark' ? darkTheme : lightTheme;

  // Keep the document chrome (scrollbars, form controls, overscroll) in step.
  useEffect(() => {
    const root = document.documentElement;
    root.style.colorScheme = mode;
    root.dataset.theme = mode;
    document.body.style.backgroundColor =
      mode === 'dark' ? palette.nightBg : palette.paper;
  }, [mode]);

  return (
    <ConfigProvider theme={config} locale={enUS} componentSize="middle">
      <AntdStyleProvider themeMode={mode} appearance={mode}>
        <AntApp>{children}</AntApp>
      </AntdStyleProvider>
    </ConfigProvider>
  );
}
