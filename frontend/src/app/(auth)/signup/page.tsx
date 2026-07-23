'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircleFilled, LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Form, Input, Progress, Typography } from 'antd';
import { authApi } from '@/lib/api';
import { AuthLayout } from '@/features/auth/components/AuthLayout';
import { SsoButtons } from '@/features/auth/components/SsoButtons';

interface SignupForm {
  email: string;
  password: string;
}

/** Deliberately two fields. Name, org, phone and billing are collected later,
 *  at the moment they're needed (docs/11 §B). */
export default function SignupPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  const strength = scorePassword(password);

  const onFinish = async (values: SignupForm) => {
    setSubmitting(true);
    setError(null);
    try {
      await authApi.signUp(values);
      router.push(`/verify-email?email=${encodeURIComponent(values.email)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Start building"
      subtitle="Two fields, then you're talking to an agent. No credit card, no setup wizard."
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <SsoButtons label="or sign up with email" />

      <Form<SignupForm> layout="vertical" onFinish={onFinish} requiredMark={false}>
        <Form.Item
          name="email"
          label="Work email"
          rules={[{ required: true, message: 'Enter your email' }, { type: 'email', message: 'That email looks wrong' }]}
          extra="We use your domain to find your team if they're already here."
        >
          <Input size="large" prefix={<MailOutlined />} placeholder="you@company.com" autoComplete="email" autoFocus />
        </Form.Item>

        <Form.Item
          name="password"
          label="Password"
          rules={[
            { required: true, message: 'Choose a password' },
            { min: 10, message: 'At least 10 characters' },
          ]}
        >
          <Input.Password
            size="large"
            prefix={<LockOutlined />}
            placeholder="At least 10 characters"
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Form.Item>

        {password && (
          <Flex align="center" gap={10} style={{ marginTop: -10, marginBottom: 16 }}>
            <Progress
              percent={strength.percent}
              size="small"
              showInfo={false}
              status={strength.percent < 50 ? 'exception' : 'success'}
              style={{ flex: 1, margin: 0 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {strength.label}
            </Typography.Text>
          </Flex>
        )}

        <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
          Create account
        </Button>
      </Form>

      <Flex vertical gap={6} style={{ marginTop: 20 }}>
        {['Free trial credits — no card required', 'Test mode by default, so nothing dials a real person'].map((line) => (
          <Flex key={line} align="center" gap={8}>
            <CheckCircleFilled style={{ fontSize: 12, opacity: 0.8 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {line}
            </Typography.Text>
          </Flex>
        ))}
      </Flex>

      <Typography.Paragraph type="secondary" style={{ marginTop: 20, textAlign: 'center' }}>
        Already have an account? <Link href="/login">Log in</Link>
      </Typography.Paragraph>
    </AuthLayout>
  );
}

function scorePassword(pw: string): { percent: number; label: string } {
  if (!pw) return { percent: 0, label: '' };
  let score = 0;
  if (pw.length >= 10) score += 35;
  if (pw.length >= 16) score += 20;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^\w\s]/.test(pw)) score += 15;
  const percent = Math.min(100, score);
  return { percent, label: percent < 50 ? 'Weak' : percent < 80 ? 'Good' : 'Strong' };
}
