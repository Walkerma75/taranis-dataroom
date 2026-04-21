import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd';
import { SafetyCertificateOutlined, LockOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;
const API_URL = import.meta.env.VITE_API_URL || '/api';

export default function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F5F6F7' }}>
        <Card style={{ width: 420, textAlign: 'center' }}>
          <Alert message="Invalid invite link" description="No token was provided." type="error" showIcon />
        </Card>
      </div>
    );
  }

  const handleSubmit = async (values) => {
    if (values.password !== values.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/auth/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: values.password }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error);
      setSuccess(true);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(145deg, #2C3E35 0%, #3A5247 50%, #2C3E35 100%)',
        padding: 24,
      }}
    >
      <Card style={{ width: 420, borderRadius: 8 }} styles={{ body: { padding: 40 } }}>
        <Space direction="vertical" size="large" style={{ width: '100%', textAlign: 'center' }}>
          <div>
            <SafetyCertificateOutlined style={{ fontSize: 40, color: '#C9A84C' }} />
            <Title level={3} style={{ marginTop: 12, marginBottom: 4 }}>Welcome to Taranis</Title>
            <Text type="secondary">Set your password to activate your account</Text>
          </div>

          {error && <Alert message={error} type="error" showIcon />}

          {success ? (
            <Space direction="vertical">
              <Alert message="Account activated!" type="success" showIcon />
              <Button type="primary" block onClick={() => navigate('/login')}>
                Go to Login
              </Button>
            </Space>
          ) : (
            <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
              <Form.Item
                name="password"
                rules={[
                  { required: true, message: 'Please enter a password' },
                  { min: 10, message: 'Password must be at least 10 characters' },
                ]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="New password" size="large" />
              </Form.Item>
              <Form.Item
                name="confirmPassword"
                rules={[{ required: true, message: 'Please confirm your password' }]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="Confirm password" size="large" />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={loading} block size="large">
                  Activate Account
                </Button>
              </Form.Item>
            </Form>
          )}
        </Space>
      </Card>
    </div>
  );
}
