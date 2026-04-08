import { useState } from 'react';
import { Layout, Menu, Typography, Button, Dropdown, Avatar, Space, Badge } from 'antd';
import {
  DashboardOutlined,
  TeamOutlined,
  FolderOutlined,
  FileTextOutlined,
  AuditOutlined,
  BellOutlined,
  SettingOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import TaranisLogo from './TaranisLogo.jsx';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

/**
 * Helper to check a capability. Admin always has everything.
 */
function hasCap(user, cap) {
  if (user?.role === 'admin') return true;
  return !!user?.capabilities?.[cap];
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const canManageUsers = hasCap(user, 'canManageUsers');
  const canManageFunds = hasCap(user, 'canManageFunds');
  const canViewAudit = hasCap(user, 'canViewAudit');

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: 'Dashboard',
    },
    {
      key: '/documents',
      icon: <FileTextOutlined />,
      label: 'Documents',
    },
    // Admin/capability-gated items
    ...((canManageUsers || canManageFunds || canViewAudit)
      ? [{ type: 'divider' }]
      : []),
    ...(canManageUsers
      ? [{
          key: '/admin/users',
          icon: <TeamOutlined />,
          label: 'Users',
        }]
      : []),
    ...(canManageFunds
      ? [{
          key: '/admin/funds',
          icon: <FolderOutlined />,
          label: 'Funds',
        }]
      : []),
    ...(canViewAudit
      ? [{
          key: '/admin/audit',
          icon: <AuditOutlined />,
          label: 'Audit Log',
        }]
      : []),
    { type: 'divider' },
    {
      key: '/notices',
      icon: <BellOutlined />,
      label: 'Notices',
    },
  ];

  const userMenuItems = [
    {
      key: 'mfa',
      icon: <SafetyCertificateOutlined />,
      label: user?.mfaEnabled ? 'MFA Enabled' : 'Set Up MFA',
      onClick: () => navigate('/settings/mfa'),
    },
    {
      key: 'password',
      icon: <SettingOutlined />,
      label: 'Change Password',
      onClick: () => navigate('/settings/password'),
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: 'Sign Out',
      danger: true,
      onClick: logout,
    },
  ];

  const selectedKey = menuItems.find((item) => item.key && location.pathname.startsWith(item.key))?.key || '/dashboard';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={240}
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
        }}
        theme="dark"
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? 0 : '0 16px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <TaranisLogo
            variant="light"
            size={collapsed ? 28 : 30}
            showText={!collapsed}
          />
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, marginTop: 8 }}
        />

        {/* Build identifier */}
        <div
          style={{
            position: 'absolute',
            bottom: 48,
            left: 0,
            right: 0,
            textAlign: 'center',
            padding: '8px 12px',
          }}
        >
          <Text
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.3)',
              fontFamily: "'Inter', monospace",
              letterSpacing: '0.03em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'block',
            }}
          >
            {typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}
          </Text>
        </div>
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 80 : 240, transition: 'margin-left 0.2s' }}>
        <Header
          style={{
            padding: '0 24px',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />

          <Space>
            <Badge dot={!user?.mfaEnabled} offset={[-4, 4]}>
              <Dropdown menu={{ items: userMenuItems }} trigger={['click']}>
                <Space style={{ cursor: 'pointer' }}>
                  <Avatar
                    style={{ backgroundColor: '#2C3E35' }}
                    size="small"
                  >
                    {user?.displayName?.[0] || 'U'}
                  </Avatar>
                  <Text>{user?.displayName}</Text>
                </Space>
              </Dropdown>
            </Badge>
          </Space>
        </Header>

        <Content style={{ padding: 24, minHeight: 'calc(100vh - 64px)' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

// Export the helper so other pages can use it
export { hasCap };
