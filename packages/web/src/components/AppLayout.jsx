import { useState, useEffect, useRef, useCallback } from 'react';
import { Layout, Menu, Typography, Button, Dropdown, Avatar, Space, Badge, Tooltip } from 'antd';
import {
  DashboardOutlined,
  TeamOutlined,
  FolderOutlined,
  FileTextOutlined,
  AuditOutlined,
  BellOutlined,
  SolutionOutlined,
  InboxOutlined,
  SettingOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api/client.js';
import TaranisLogo from './TaranisLogo.jsx';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

/**
 * How often the due diligence badge may ask the server, at most.
 *
 * The badge refreshes when the admin navigates, which is the moment the figure
 * is most likely to have changed and the moment they are most likely to look at
 * it. This is the floor under that, so moving quickly between five screens is
 * one request rather than five. The interval underneath it catches the page
 * that is left open all morning.
 */
const BADGE_MIN_INTERVAL_MS = 5 * 60 * 1000;

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

  // ---------------------------------------------------------------------
  // The due diligence badge
  //
  // Admins only, on the role and not on a capability: `/dd-summary` is admin
  // only by decision (CW020 §5), and advisors and viewers do reach this layout
  // and do see the Companies and Review Queue items in the nav. Asking on their
  // behalf would put a 403 on every page they open.
  //
  // Failure is silent by design. A badge is a convenience; a red error toast on
  // every navigation because the summary query is slow would not be.
  // ---------------------------------------------------------------------
  const isAdmin = user?.role === 'admin';
  const [awaitingTaranis, setAwaitingTaranis] = useState(0);
  const lastFetchedAt = useRef(0);

  const refreshBadge = useCallback(async ({ force = false } = {}) => {
    if (!isAdmin) return;
    const now = Date.now();
    if (!force && now - lastFetchedAt.current < BADGE_MIN_INTERVAL_MS) return;
    lastFetchedAt.current = now;

    try {
      const res = await api.get('/dd-summary');
      if (!res.ok) return;
      const body = await res.json();
      setAwaitingTaranis(body?.awaitingTaranis?.total || 0);
    } catch { /* leave the last known figure in place */ }
  }, [isAdmin]);

  // On navigation, throttled by the check above.
  useEffect(() => { refreshBadge(); }, [refreshBadge, location.pathname]);

  // And for the page nobody navigates away from.
  useEffect(() => {
    if (!isAdmin) return undefined;
    const timer = setInterval(() => refreshBadge({ force: true }), BADGE_MIN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isAdmin, refreshBadge]);

  const canManageUsers = hasCap(user, 'canManageUsers');
  const canManageFunds = hasCap(user, 'canManageFunds');
  const canViewAudit = hasCap(user, 'canViewAudit');

  // Due diligence is for the deal side. Investors never see it; an advisor or
  // viewer may hold a named assignment to one company, and the API scopes both
  // pages to whatever they are assigned to (an empty list if nothing).
  const seesDueDiligence = ['admin', 'advisor', 'viewer'].includes(user?.role);

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
    // Due diligence portal
    ...(seesDueDiligence
      ? [
          { type: 'divider' },
          {
            // Labelled for the question people actually arrive with. "Due
            // Diligence" described the section accurately and still sent
            // someone looking for "where do I add a company" past it; the
            // page's own heading carries the due diligence framing instead,
            // and Review Queue sitting beneath it keeps the grouping obvious.
            key: '/admin/companies',
            icon: <SolutionOutlined />,
            label: 'Companies',
          },
          {
            key: '/admin/review-queue',
            icon: <InboxOutlined />,
            label: 'Review Queue',
          },
        ]
      : []),
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

          <Space size={16}>
            {/*
              Straight to the review queue rather than back to the dashboard.
              The number IS that queue's contents, and the queue is where the
              work is done; sending an admin to a panel that repeats the figure
              they just clicked would add a step to every use of it. The link
              carries status=all because the badge counts files being read as
              well as files nobody has opened (HANDOVER-C020 D3).
            */}
            {isAdmin && awaitingTaranis > 0 && (
              <Tooltip title={`${awaitingTaranis} submitted file(s) awaiting Taranis`}>
                <Badge count={awaitingTaranis} offset={[-2, 4]} color="#C9A84C">
                  <Button
                    type="text"
                    icon={<InboxOutlined style={{ fontSize: 18 }} />}
                    onClick={() => navigate('/admin/review-queue?status=all')}
                    aria-label={`${awaitingTaranis} items awaiting Taranis`}
                  />
                </Badge>
              </Tooltip>
            )}

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
