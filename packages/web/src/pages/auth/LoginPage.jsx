import { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { useAuth } from '../../context/AuthContext.jsx';
import TaranisLogo from '../../components/TaranisLogo.jsx';

const { Title, Text } = Typography;

export default function LoginPage() {
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [credentials, setCredentials] = useState(null);

  const handleLogin = async (values) => {
    setLoading(true);
    setError(null);

    const result = await login(
      values.email,
      values.password,
      mfaRequired ? values.totpCode : undefined
    );

    setLoading(false);

    if (result.error) {
      setError(result.error);
    } else if (result.mfaRequired && !mfaRequired) {
      setMfaRequired(true);
      setCredentials({ email: values.email, password: values.password });
    }
  };

  const handleMfaSubmit = async (values) => {
    setLoading(true);
    setError(null);

    const result = await login(credentials.email, credentials.password, values.totpCode);
    setLoading(false);

    if (result.error) {
      setError(result.error);
    }
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
      <Card
        style={{ width: 420, borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
        styles={{ body: { padding: 40 } }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%', textAlign: 'center' }}>
          <div>
            <TaranisLogo variant="dark" size={40} />
            <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>Data Room</Text>
          </div>

          {error && <Alert message={error} type="error" showIcon />}

          {!mfaRequired ? (
            <Form layout="vertical" onFinish={handleLogin} requiredMark={false}>
              <Form.Item
                name="email"
                rules={[{ required: true, message: 'Please enter your email' }]}
              >
                <Input
                  prefix={<MailOutlined />}
                  placeholder="Email address"
                  size="large"
                  autoFocus
                />
              </Form.Item>
              <Form.Item
                name="password"
                rules={[{ required: true, message: 'Please enter your password' }]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="Password"
                  size="large"
                />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  size="large"
                >
                  Sign In
                </Button>
              </Form.Item>
            </Form>
          ) : (
            <Form layout="vertical" onFinish={handleMfaSubmit} requiredMark={false}>
              <Text style={{ display: 'block', marginBottom: 16 }}>
                Enter the 6-digit code from your authenticator app.
              </Text>
              <Form.Item
                name="totpCode"
                rules={[{ required: true, message: 'Please enter your TOTP code' }]}
              >
                <Input
                  placeholder="000000"
                  size="large"
                  maxLength={6}
                  autoFocus
                  style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20 }}
                />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  size="large"
                >
                  Verify
                </Button>
              </Form.Item>
              <Button type="link" onClick={() => { setMfaRequired(false); setCredentials(null); }}>
                Back to login
              </Button>
            </Form>
          )}
        </Space>
      </Card>
    </div>
  );
}
