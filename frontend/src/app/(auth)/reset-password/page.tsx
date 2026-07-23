'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { LockOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { authApi } from '@/lib/api';
import { AuthLayout } from '@/features/auth/components/AuthLayout';

function ResetPasswordInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async ({ password }: { password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await authApi.resetPassword({ token, password });
      router.push('/login');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout title="Link expired">
        <Alert
          type="warning"
          showIcon
          message="This reset link is missing or expired."
          description="Request a new one — links are valid for 30 minutes."
        />
        <Link href="/forgot-password">
          <Button type="primary" size="large" block style={{ marginTop: 18 }}>
            Request a new link
          </Button>
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed out of other devices.">
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
        <Form.Item
          name="password"
          label="New password"
          rules={[{ required: true, message: 'Choose a password' }, { min: 10, message: 'At least 10 characters' }]}
        >
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" autoFocus />
        </Form.Item>

        <Form.Item
          name="confirm"
          label="Confirm password"
          dependencies={['password']}
          rules={[
            { required: true, message: 'Confirm your password' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || getFieldValue('password') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('Passwords do not match')),
            }),
          ]}
        >
          <Input.Password size="large" prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>

        <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
          Set new password
        </Button>
      </Form>

      <Typography.Paragraph type="secondary" style={{ marginTop: 22, textAlign: 'center' }}>
        <Link href="/login">Back to log in</Link>
      </Typography.Paragraph>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
