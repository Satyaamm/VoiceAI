'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Flex, Input, Typography } from 'antd';
import { authApi } from '@/lib/api';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { useSessionStore } from '@/stores/session-store';

const RESEND_SECONDS = 30;

function VerifyEmailInner() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const setSession = useSessionStore((s) => s.setSession);

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const submit = async (value: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const { session } = await authApi.verifyEmail({ email, code: value });
      setSession(session);
      const org = session.organizations.find((o) => o.id === session.currentOrgId);
      const ws = session.workspaces.find((w) => w.id === session.currentWorkspaceId);
      // Straight to a working agent — no wizard, no forms (docs/11 §A).
      router.push(org && ws ? `/orgs/${org.slug}/${ws.slug}/welcome` : '/orgs');
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    setCooldown(RESEND_SECONDS);
    try {
      await authApi.resendCode(email);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <AuthLayout
      title="Check your email"
      subtitle={
        <>
          We sent a 6-digit code to <Typography.Text strong>{email || 'your inbox'}</Typography.Text>. It
          expires in 10 minutes.
        </>
      }
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Input.OTP
        length={6}
        size="large"
        value={code}
        onChange={(value) => {
          setCode(value);
          if (value.length === 6) void submit(value);
        }}
        disabled={submitting}
        autoFocus
      />

      <Button
        type="primary"
        size="large"
        block
        style={{ marginTop: 22 }}
        loading={submitting}
        disabled={code.length !== 6}
        onClick={() => void submit(code)}
      >
        Verify and continue
      </Button>

      <Flex justify="space-between" align="center" style={{ marginTop: 18 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Didn&apos;t get it? Check spam.
        </Typography.Text>
        <Button type="link" size="small" disabled={cooldown > 0} onClick={() => void resend()}>
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </Button>
      </Flex>
    </AuthLayout>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
