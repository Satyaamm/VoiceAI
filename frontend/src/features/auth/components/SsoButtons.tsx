'use client';

import { Button, Divider, Flex } from 'antd';
import { authApi } from '@/lib/api';

/** Brand marks inlined — the CSP-friendly option, and no icon font to load. */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.3z" />
      <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 23 23" aria-hidden>
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}

export function SsoButtons({ label = 'or continue with' }: { label?: string }) {
  return (
    <>
      <Flex gap={10}>
        <Button
          block
          size="large"
          icon={<GoogleMark />}
          href={authApi.ssoUrl('google')}
        >
          Google
        </Button>
        <Button
          block
          size="large"
          icon={<MicrosoftMark />}
          href={authApi.ssoUrl('microsoft')}
        >
          Microsoft
        </Button>
      </Flex>
      <Divider plain style={{ margin: '18px 0', fontSize: 12 }}>
        {label}
      </Divider>
    </>
  );
}
