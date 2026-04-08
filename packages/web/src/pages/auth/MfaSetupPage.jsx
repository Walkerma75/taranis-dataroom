import { useState } from 'react';
import { Card, Typography, Button, Input, Steps, Alert, Space, Checkbox, message } from 'antd';
import { SafetyCertificateOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';

const { Title, Text, Paragraph } = Typography;

export default function MfaSetupPage() {
  const { user, setUser } = useAuth();
  const [step, setStep] = useState(0);
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [codesConfirmed, setCodesConfirmed] = useState(false);
  const navigate = useNavigate();

  const startSetup = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/auth/mfa/setup');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setStep(1);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const verifyCode = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/auth/mfa/verify', { code });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRecoveryCodes(data.recoveryCodes);
      setUser({ ...user, mfaEnabled: true });
      setStep(2);
      message.success('MFA enabled successfully');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  if (user?.mfaEnabled && !recoveryCodes) {
    return (
      <Card style={{ maxWidth: 500, margin: '40px auto' }}>
        <Space direction="vertical" align="center" style={{ width: '100%' }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a' }} />
          <Title level={4}>MFA is enabled</Title>
          <Text type="secondary">
            Two-factor authentication is already set up on your account.
          </Text>
        </Space>
      </Card>
    );
  }

  return (
    <Card style={{ maxWidth: 500, margin: '40px auto' }}>
      <Title level={4}>
        <SafetyCertificateOutlined /> Set Up Two-Factor Authentication
      </Title>

      <Steps current={step} style={{ marginBottom: 24 }}
        items={[
          { title: 'Start' },
          { title: 'Scan QR' },
          { title: 'Complete' },
        ]}
      />

      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      {step === 0 && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Paragraph>
            Protect your account with a TOTP authenticator app (e.g. Google Authenticator,
            Authy, 1Password). You will need to enter a code from the app each time you sign in.
          </Paragraph>
          <Button type="primary" onClick={startSetup} loading={loading} block>
            Begin Setup
          </Button>
        </Space>
      )}

      {step === 1 && (
        <Space direction="vertical" size="middle" style={{ width: '100%', textAlign: 'center' }}>
          <Paragraph>Scan this QR code with your authenticator app:</Paragraph>
          {qrCode && <img src={qrCode} alt="MFA QR Code" style={{ width: 200, height: 200 }} />}
          <Text type="secondary" copyable style={{ fontSize: 12 }}>
            Manual key: {secret}
          </Text>
          <Text>Then enter the 6-digit code below:</Text>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            maxLength={6}
            style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: 20, maxWidth: 200, margin: '0 auto' }}
          />
          <Button type="primary" onClick={verifyCode} loading={loading} disabled={code.length !== 6} block>
            Verify &amp; Enable
          </Button>
        </Space>
      )}

      {step === 2 && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            message="MFA enabled!"
            description="Save these recovery codes somewhere safe. Each can be used once if you lose access to your authenticator."
            type="success"
            showIcon
          />
          <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 6, fontFamily: 'monospace' }}>
            {recoveryCodes?.map((c, i) => (
              <div key={i}>{c}</div>
            ))}
          </div>
          <Text type="warning">
            These codes will not be shown again. Please copy them now.
          </Text>
          <Checkbox
            checked={codesConfirmed}
            onChange={(e) => setCodesConfirmed(e.target.checked)}
          >
            I have saved my recovery codes
          </Checkbox>
          <Button
            type="primary"
            block
            disabled={!codesConfirmed}
            onClick={() => navigate('/dashboard')}
          >
            Close
          </Button>
        </Space>
      )}
    </Card>
  );
}
