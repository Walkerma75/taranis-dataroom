import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Typography, Space, Tag, Button } from 'antd';
import {
  TeamOutlined,
  FolderOutlined,
  FileTextOutlined,
  SafetyCertificateOutlined,
  BellOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { hasCap } from '../components/AppLayout.jsx';

const { Title, Text } = Typography;

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({ users: 0, funds: [], documents: 0, unreadNotices: 0 });

  const canManageUsers = hasCap(user, 'canManageUsers');

  useEffect(() => {
    async function loadStats() {
      try {
        const promises = [
          api.get('/funds'),
          api.get('/documents'),
          api.get('/notices'),
        ];
        // Only fetch users if the user has the capability
        if (canManageUsers) {
          promises.push(api.get('/users'));
        }

        const results = await Promise.all(promises);

        const funds = results[0].ok ? await results[0].json() : [];
        const docs = results[1].ok ? await results[1].json() : [];
        const notices = results[2].ok ? await results[2].json() : [];
        const users = results[3]?.ok ? await results[3].json() : [];

        // Count unread notices (non-admin: those without read_at)
        const unreadNotices = notices.filter((n) => !n.read_at).length;

        setStats({
          users: users.length,
          funds,
          documents: docs.length,
          unreadNotices,
        });
      } catch { /* ignore */ }
    }
    loadStats();
  }, [user, canManageUsers]);

  return (
    <div>
      <Title level={3}>Dashboard</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        Welcome back, {user?.displayName}
      </Text>

      <Row gutter={[16, 16]}>
        {canManageUsers && (
          <Col xs={24} sm={8} md={6}>
            <Card hoverable onClick={() => navigate('/admin/users')}>
              <Statistic
                title="Users"
                value={stats.users}
                prefix={<TeamOutlined />}
                valueStyle={{ color: '#2C3E35' }}
              />
            </Card>
          </Col>
        )}
        <Col xs={24} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/documents')}>
            <Statistic
              title="Funds"
              value={stats.funds.length}
              prefix={<FolderOutlined />}
              valueStyle={{ color: '#2C3E35' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/documents')}>
            <Statistic
              title="Documents"
              value={stats.documents}
              prefix={<FileTextOutlined />}
              valueStyle={{ color: '#2C3E35' }}
            />
          </Card>
        </Col>
        {stats.unreadNotices > 0 && (
          <Col xs={24} sm={8} md={6}>
            <Card hoverable onClick={() => navigate('/notices')}>
              <Statistic
                title="Unread Notices"
                value={stats.unreadNotices}
                prefix={<BellOutlined />}
                valueStyle={{ color: '#C9A84C' }}
              />
            </Card>
          </Col>
        )}
      </Row>

      <Title level={4} style={{ marginTop: 32 }}>Your Funds</Title>
      <Row gutter={[16, 16]}>
        {stats.funds.map((fund) => (
          <Col xs={24} sm={8} key={fund.id}>
            <Card
              title={fund.name}
              extra={<Tag color={fund.status === 'active' ? 'green' : 'default'}>{fund.status}</Tag>}
              hoverable
              onClick={() => navigate(`/documents?fundId=${fund.id}`)}
            >
              <Text type="secondary">{fund.description}</Text>
              <div style={{ marginTop: 12 }}>
                <Statistic
                  value={fund.docCount}
                  suffix="documents"
                  valueStyle={{ fontSize: 16 }}
                />
              </div>
            </Card>
          </Col>
        ))}
        {stats.funds.length === 0 && (
          <Col xs={24}>
            <Card>
              <Text type="secondary">No funds available. Contact your administrator for access.</Text>
            </Card>
          </Col>
        )}
      </Row>

      {!user?.mfaEnabled && (
        <Card
          style={{ marginTop: 24, borderColor: '#C9A84C' }}
          size="small"
          hoverable
          onClick={() => navigate('/settings/mfa')}
        >
          <Space>
            <SafetyCertificateOutlined style={{ color: '#C9A84C', fontSize: 20 }} />
            <Text>
              Two-factor authentication is not set up. We recommend enabling it for security.
            </Text>
          </Space>
        </Card>
      )}
    </div>
  );
}
