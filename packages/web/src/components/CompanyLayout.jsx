import { useState } from 'react';
import { Layout, Menu, Typography, Button, Dropdown, Avatar, Space } from 'antd';
import {
  CheckSquareOutlined,
  CloudUploadOutlined,
  FileProtectOutlined,
  FolderOpenOutlined,
  TeamOutlined,
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
 * The shell a company user sees.
 *
 * Deliberately a separate component from AppLayout rather than a set of
 * conditionals inside it. Nothing fund-related is imported here, so there is no
 * navigation item, no menu entry and no route a company user could reach by
 * accident or by editing a URL, and no future change to the fund navigation can
 * leak into the company view.
 */
export default function CompanyLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const isCompanyAdmin = user?.companyRole === 'company_admin';

  const menuItems = [
    { key: '/company', icon: <CheckSquareOutlined />, label: 'Information requests' },
    { key: '/company/staged', icon: <CloudUploadOutlined />, label: 'Ready to submit' },
    { key: '/company/receipts', icon: <FileProtectOutlined />, label: 'Receipts' },
    // Every company role can read what Taranis has shared, per code brief §3.2,
    // so this entry is not gated the way "Your team" is.
    { key: '/company/shared', icon: <FolderOpenOutlined />, label: 'From Taranis' },
    ...(isCompanyAdmin
      ? [{ key: '/company/team', icon: <TeamOutlined />, label: 'Your team' }]
      : []),
  ];

  const userMenuItems = [
    {
      key: 'mfa',
      icon: <SafetyCertificateOutlined />,
      label: user?.mfaEnabled ? 'Two-factor enabled' : 'Set up two-factor',
      onClick: () => navigate('/settings/mfa'),
    },
    {
      key: 'password',
      icon: <SettingOutlined />,
      label: 'Change password',
      onClick: () => navigate('/settings/password'),
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: 'Sign out',
      danger: true,
      onClick: logout,
    },
  ];

  // Longest match wins, so /company/staged does not also select /company.
  const selectedKey = menuItems
    .filter((item) => location.pathname.startsWith(item.key))
    .sort((a, b) => b.key.length - a.key.length)[0]?.key || '/company';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={260}
        style={{ overflow: 'auto', height: '100vh', position: 'fixed', left: 0, top: 0, bottom: 0 }}
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
          <TaranisLogo variant="light" size={collapsed ? 28 : 30} showText={!collapsed} />
        </div>

        {!collapsed && (
          <div style={{ padding: '12px 16px 0' }}>
            <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.08em' }}>
              DUE DILIGENCE
            </Text>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 2 }}>
              {user?.companyName}
            </div>
          </div>
        )}

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, marginTop: 12 }}
        />
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 80 : 260, transition: 'margin-left 0.2s' }}>
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

          <Dropdown menu={{ items: userMenuItems }} trigger={['click']}>
            <Space style={{ cursor: 'pointer' }}>
              <Avatar style={{ backgroundColor: '#2C3E35' }} size="small">
                {user?.displayName?.[0] || 'U'}
              </Avatar>
              <Text>{user?.displayName}</Text>
            </Space>
          </Dropdown>
        </Header>

        <Content style={{ padding: 24, minHeight: 'calc(100vh - 64px)' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
