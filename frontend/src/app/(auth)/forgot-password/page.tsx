'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Result, Typography } from 'antd';
import { authApi } from '@/lib/api';
import { AuthLayout } from '@/features/auth/components/AuthLayout';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async ({ email }: { email: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await authApi.requestPasswordReset(email);
      setSent(email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout title="Reset link sent">
        <Result
          status="success"
          title="Check your inbox"
          subTitle={`If an account exists for ${sent}, a reset link is on its way. It expires in 30 minutes.`}
          extra={
            <Link href="/login">
              <Button icon={<ArrowLeftOutlined />}>Back to log in</Button>
            </Link>
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter the email you signed up with and we'll send you a link."
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
        <Form.Item
          name="email"
          label="Work email"
          rules={[{ required: true, message: 'Enter your email' }, { type: 'email', message: 'That email looks wrong' }]}
        >
          <Input size="large" prefix={<MailOutlined />} placeholder="you@company.com" autoFocus />
        </Form.Item>
        <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
          Send reset link
        </Button>
      </Form>

      <Typography.Paragraph type="secondary" style={{ marginTop: 22, textAlign: 'center' }}>
        <Link href="/login">Back to log in</Link>
      </Typography.Paragraph>
    </AuthLayout>
  );
}
