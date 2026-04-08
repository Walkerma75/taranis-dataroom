import { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, message } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';

const { Title } = Typography;

export default function ChangePasswordPage() {
  const { logout } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (values) => {
    if (values.newPassword !== values.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await api.post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success('Password changed. Please sign in again.');
      setTimeout(() => logout(), 1500);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <Card style={{ maxWidth: 500, margin: '40px auto' }}>
      <Title level={4}><LockOutlined /> Change Password</Title>

      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
        <Form.Item name="currentPassword" label="Current Password" rules={[{ required: true }]}>
          <Input.Password size="large" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="New Password"
          rules={[
            { required: true },
            { min: 10, message: 'At least 10 characters' },
          ]}
        >
          <Input.Password size="large" />
        </Form.Item>
        <Form.Item name="confirmPassword" label="Confirm New Password" rules={[{ required: true }]}>
          <Input.Password size="large" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block size="large">
            Change Password
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
