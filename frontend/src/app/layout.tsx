import type { Metadata, Viewport } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { ThemeProvider } from '@/theme/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VoiceAI', template: '%s · VoiceAI' },
  description: 'Build, test and operate AI voice agents.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFAF8' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0D0C' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* AntdRegistry extracts antd's CSS-in-JS server-side — without it every
            page load flashes unstyled (docs/07 §Setup traps 2). */}
        <AntdRegistry>
          <ThemeProvider>{children}</ThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
