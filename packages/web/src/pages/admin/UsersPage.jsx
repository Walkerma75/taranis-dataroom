import { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Tag, Space, Typography, Modal, Form, Input, Select, message,
  Tooltip, Card, Drawer, Checkbox, Alert, Divider, Descriptions, Switch, Empty,
} from 'antd';
import {
  PlusOutlined, CheckCircleOutlined, CloseCircleOutlined, MailOutlined,
  SafetyCertificateOutlined, KeyOutlined, CopyOutlined, EditOutlined,
  SaveOutlined, SettingOutlined,
} from '@ant-design/icons';
import { api } from '../../api/client.js';

const { Title, Text, Paragraph } = Typography;

const roleColours = {
  admin: 'red',
  investor: 'blue',
  advisor: 'purple',
  viewer: 'default',
};

const statusColours = {
  active: 'green',
  invited: 'gold',
  disabled: 'default',
};

// Default capabilities for each role preset
const rolePresets = {
  admin: {
    canManageUsers: true,
    canManageFunds: true,
    canUploadDocuments: true,
    canViewAudit: true,
    canDownloadDocuments: true,
    canViewDocuments: true,
  },
  investor: {
    canManageUsers: false,
    canManageFunds: false,
    canUploadDocuments: false,
    canViewAudit: false,
    canDownloadDocuments: true,
    canViewDocuments: true,
  },
  advisor: {
    canManageUsers: false,
    canManageFunds: false,
    canUploadDocuments: true,
    canViewAudit: false,
    canDownloadDocuments: true,
    canViewDocuments: true,
  },
  viewer: {
    canManageUsers: false,
    canManageFunds: false,
    canUploadDocuments: false,
    canViewAudit: false,
    canDownloadDocuments: false,
    canViewDocuments: true,
  },
};

const capabilityLabels = {
  canManageUsers: 'Manage Users',
  canManageFunds: 'Manage Funds',
  canUploadDocuments: 'Upload Documents',
  canViewAudit: 'View Audit Log',
  canDownloadDocuments: 'Download Documents',
  canViewDocuments: 'View Documents',
};

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [form] = Form.useForm();

  // Password reset state
  const [resetResult, setResetResult] = useState(null);

  // Permissions drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [funds, setFunds] = useState([]);
  const [categories, setCategories] = useState([]);
  const [grants, setGrants] = useState({});
  const [userCaps, setUserCaps] = useState({});
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsSaving, setGrantsSaving] = useState(false);
  const [drawerFundId, setDrawerFundId] = useState(null);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users');
      if (res.ok) setUsers(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    loadUsers();
    // Load funds and categories for the permissions drawer
    Promise.all([
      api.get('/funds').then((r) => r.json()),
      api.get('/funds/categories').then((r) => r.json()),
    ]).then(([f, c]) => {
      setFunds(f);
      setCategories(c);
    });
  }, []);

  // ---- Invite flow ----
  const handleInvite = async (values) => {
    setInviteLoading(true);
    try {
      const res = await api.post('/auth/invite', values);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Show the invite link to the admin
      const inviteUrl = `${window.location.origin}${data.inviteUrl}`;
      setInviteResult({ email: values.email, displayName: values.displayName, inviteUrl });
      loadUsers();
    } catch (err) {
      message.error(err.message);
    }
    setInviteLoading(false);
  };

  const closeInviteModal = () => {
    setInviteOpen(false);
    setInviteResult(null);
    form.resetFields();
  };

  const copyInviteLink = () => {
    navigator.clipboard.writeText(inviteResult.inviteUrl);
    message.success('Invite link copied to clipboard');
  };

  // ---- Password reset ----
  const handleResetPassword = async (userId) => {
    try {
      const res = await api.post('/auth/reset-password', { userId });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const resetUrl = `${window.location.origin}${data.resetUrl}`;
      setResetResult(resetUrl);
    } catch (err) {
      message.error(err.message);
    }
  };

  // ---- User status ----
  const handleStatusChange = async (userId, status) => {
    try {
      const res = await api.patch(`/users/${userId}`, { status });
      if (!res.ok) throw new Error('Failed to update');
      message.success('User updated');
      loadUsers();
    } catch (err) {
      message.error(err.message);
    }
  };

  // ---- Permissions drawer ----
  const openPermissions = async (user) => {
    setSelectedUser(user);
    setDrawerOpen(true);
    setDrawerFundId(null);
    setGrantsLoading(true);
    setUserCaps(user.capabilities || rolePresets[user.role] || rolePresets.viewer);

    try {
      const res = await api.get(`/grants?userId=${user.id}`);
      const data = await res.json();
      const map = {};
      data.forEach((g) => {
        map[`${g.fundId}::${g.categoryId}`] = {
          granted: true,
          downloadAllowed: g.downloadAllowed,
        };
      });
      setGrants(map);
    } catch { /* ignore */ }
    setGrantsLoading(false);
  };

  const toggleGrant = (fundId, catId) => {
    const key = `${fundId}::${catId}`;
    setGrants((prev) => {
      const existing = prev[key];
      if (existing?.granted) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      // Default download to match the user's canDownloadDocuments capability
      const downloadDefault = !!userCaps.canDownloadDocuments;
      return { ...prev, [key]: { granted: true, downloadAllowed: downloadDefault } };
    });
  };

  const toggleDownload = (fundId, catId) => {
    const key = `${fundId}::${catId}`;
    setGrants((prev) => ({
      ...prev,
      [key]: { ...prev[key], downloadAllowed: !prev[key]?.downloadAllowed },
    }));
  };

  const selectAllForFund = (fundId) => {
    const downloadDefault = !!userCaps.canDownloadDocuments;
    setGrants((prev) => {
      const next = { ...prev };
      categories.forEach((cat) => {
        const key = `${fundId}::${cat.id}`;
        // Keep existing download setting if already granted, otherwise use default
        next[key] = next[key]?.granted
          ? next[key]
          : { granted: true, downloadAllowed: downloadDefault };
      });
      return next;
    });
  };

  const clearAllForFund = (fundId) => {
    setGrants((prev) => {
      const next = { ...prev };
      categories.forEach((cat) => {
        delete next[`${fundId}::${cat.id}`];
      });
      return next;
    });
  };

  const applyPreset = (role) => {
    setUserCaps(rolePresets[role] || rolePresets.viewer);
    // Also update the user's role to match the preset
    setSelectedUser((prev) => prev ? { ...prev, role } : null);
  };

  const toggleCap = (capKey) => {
    setUserCaps((prev) => ({ ...prev, [capKey]: !prev[capKey] }));
  };

  const saveGrants = async () => {
    setGrantsSaving(true);
    try {
      const grantList = Object.entries(grants)
        .filter(([, v]) => v.granted)
        .map(([key, v]) => {
          const [fundId, categoryId] = key.split('::');
          return { fundId, categoryId, downloadAllowed: v.downloadAllowed };
        });

      // Save grants
      const grantRes = await api.post('/grants/bulk', { userId: selectedUser.id, grants: grantList });
      const grantData = await grantRes.json();
      if (!grantRes.ok) throw new Error(grantData.error || 'Failed to save grants');

      // Save capabilities and role
      const capRes = await api.patch(`/users/${selectedUser.id}`, { capabilities: userCaps, role: selectedUser.role });
      if (!capRes.ok) throw new Error('Failed to save capabilities');

      message.success(`Permissions saved — ${grantList.length} grants applied`);
      loadUsers();
    } catch (err) {
      message.error(err.message);
    }
    setGrantsSaving(false);
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'displayName',
      sorter: (a, b) => a.displayName.localeCompare(b.displayName),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      sorter: (a, b) => a.email.localeCompare(b.email),
    },
    {
      title: 'Role',
      dataIndex: 'role',
      render: (role) => <Tag color={roleColours[role] || 'default'}>{role}</Tag>,
      filters: Object.keys(roleColours).map((r) => ({ text: r, value: r })),
      onFilter: (value, record) => record.role === value,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (status) => <Tag color={statusColours[status]}>{status}</Tag>,
      filters: Object.keys(statusColours).map((s) => ({ text: s, value: s })),
      onFilter: (value, record) => record.status === value,
    },
    {
      title: 'MFA',
      dataIndex: 'mfaEnabled',
      render: (enabled) =>
        enabled ? (
          <Tooltip title="MFA enabled">
            <CheckCircleOutlined style={{ color: '#52c41a' }} />
          </Tooltip>
        ) : (
          <Tooltip title="MFA not set up">
            <CloseCircleOutlined style={{ color: '#d9d9d9' }} />
          </Tooltip>
        ),
      width: 60,
      align: 'center',
    },
    {
      title: 'Grants',
      dataIndex: 'activeGrants',
      sorter: (a, b) => a.activeGrants - b.activeGrants,
      width: 80,
      align: 'center',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space>
          <Tooltip title="Manage permissions">
            <Button
              icon={<KeyOutlined />}
              size="small"
              onClick={() => openPermissions(record)}
            >
              Permissions
            </Button>
          </Tooltip>
          {record.status !== 'disabled' && (
            <Tooltip title="Generate password reset link">
              <Button
                icon={<SafetyCertificateOutlined />}
                size="small"
                onClick={() => handleResetPassword(record.id)}
              >
                Reset PW
              </Button>
            </Tooltip>
          )}
          {record.status === 'active' && (
            <Button size="small" danger onClick={() => handleStatusChange(record.id, 'disabled')}>
              Disable
            </Button>
          )}
          {record.status === 'disabled' && (
            <Button size="small" onClick={() => handleStatusChange(record.id, 'active')}>
              Enable
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Users</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setInviteOpen(true)}>
          Invite User
        </Button>
      </div>

      <Card>
        <Table
          dataSource={users}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
          size="middle"
        />
      </Card>

      {/* Invite modal — two stages: form, then invite link */}
      <Modal
        title={inviteResult ? 'Invite Created' : 'Invite User'}
        open={inviteOpen}
        onCancel={closeInviteModal}
        footer={null}
        destroyOnClose
      >
        {inviteResult ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              message={`Invite created for ${inviteResult.displayName}`}
              description={`Send the link below to ${inviteResult.email}. They will use it to set their password and activate their account. The link expires in 7 days.`}
              type="success"
              showIcon
            />
            <Input.Group compact style={{ display: 'flex' }}>
              <Input
                value={inviteResult.inviteUrl}
                readOnly
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              />
              <Button icon={<CopyOutlined />} onClick={copyInviteLink}>
                Copy
              </Button>
            </Input.Group>
            <Button type="primary" block onClick={closeInviteModal}>
              Done
            </Button>
          </Space>
        ) : (
          <Form form={form} layout="vertical" onFinish={handleInvite}>
            <Form.Item
              name="email"
              label="Email"
              rules={[{ required: true, type: 'email', message: 'Valid email required' }]}
            >
              <Input prefix={<MailOutlined />} placeholder="investor@example.com" />
            </Form.Item>
            <Form.Item
              name="displayName"
              label="Display Name"
              rules={[{ required: true, message: 'Name required' }]}
            >
              <Input placeholder="John Smith" />
            </Form.Item>
            <Form.Item name="role" label="Role" initialValue="investor">
              <Select
                options={[
                  { value: 'admin', label: 'Admin' },
                  { value: 'investor', label: 'Investor' },
                  { value: 'advisor', label: 'Advisor' },
                  { value: 'viewer', label: 'Viewer' },
                ]}
              />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={inviteLoading} block>
                Create Invite
              </Button>
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* Password reset link modal */}
      <Modal
        title="Password Reset Link"
        open={!!resetResult}
        onCancel={() => setResetResult(null)}
        footer={null}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            message="Reset link generated"
            description="Send this link to the user. They will use it to set a new password. The link expires in 24 hours."
            type="success"
            showIcon
          />
          <Input.Group compact style={{ display: 'flex' }}>
            <Input
              value={resetResult}
              readOnly
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(resetResult);
                message.success('Reset link copied to clipboard');
              }}
            >
              Copy
            </Button>
          </Input.Group>
          <Button type="primary" block onClick={() => setResetResult(null)}>
            Done
          </Button>
        </Space>
      </Modal>

      {/* Permissions drawer — slides out from right when you click Permissions on a user */}
      <Drawer
        title={selectedUser ? `Permissions — ${selectedUser.displayName}` : 'Permissions'}
        placement="right"
        width={640}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={saveGrants}
            loading={grantsSaving}
          >
            Save
          </Button>
        }
      >
        {selectedUser && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="Email">{selectedUser.email}</Descriptions.Item>
              <Descriptions.Item label="Role">
                <Tag color={roleColours[selectedUser.role] || 'default'}>{selectedUser.role}</Tag>
              </Descriptions.Item>
            </Descriptions>
            <Alert
              message="Applying a preset will also update the user's role to match."
              type="info"
              showIcon
              style={{ fontSize: 12 }}
            />

            {/* Capabilities section */}
            <Card
              title={<><SettingOutlined /> Capabilities</>}
              size="small"
              extra={
                <Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>Apply preset:</Text>
                  {Object.keys(rolePresets).map((r) => (
                    <Button key={r} size="small" onClick={() => applyPreset(r)}>
                      {r.charAt(0).toUpperCase() + r.slice(1)}
                    </Button>
                  ))}
                </Space>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
                {Object.entries(capabilityLabels).map(([key, label]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text>{label}</Text>
                    <Switch
                      size="small"
                      checked={!!userCaps[key]}
                      onChange={() => toggleCap(key)}
                    />
                  </div>
                ))}
              </div>
            </Card>

            <Divider style={{ margin: '8px 0' }} />

            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              Select a fund below and tick the document categories this user should have access to.
            </Text>

            <Select
              placeholder="Select a fund..."
              style={{ width: '100%', marginBottom: 16 }}
              value={drawerFundId}
              onChange={setDrawerFundId}
              options={funds.map((f) => {
                // Show how many categories are granted for this fund
                const grantedCount = categories.filter((c) => grants[`${f.id}::${c.id}`]?.granted).length;
                return {
                  value: f.id,
                  label: `${f.name}${grantedCount > 0 ? ` (${grantedCount} categories)` : ''}`,
                };
              })}
            />

            {drawerFundId && (
              <Card
                title={funds.find((f) => f.id === drawerFundId)?.name}
                size="small"
                extra={
                  <Space>
                    <Button size="small" onClick={() => selectAllForFund(drawerFundId)}>All</Button>
                    <Button size="small" onClick={() => clearAllForFund(drawerFundId)}>Clear</Button>
                  </Space>
                }
              >
                <Table
                  dataSource={categories}
                  rowKey="id"
                  pagination={false}
                  size="small"
                  loading={grantsLoading}
                  columns={[
                    { title: 'Category', dataIndex: 'name' },
                    {
                      title: 'Access',
                      width: 70,
                      align: 'center',
                      render: (_, cat) => (
                        <Checkbox
                          checked={!!grants[`${drawerFundId}::${cat.id}`]?.granted}
                          onChange={() => toggleGrant(drawerFundId, cat.id)}
                        />
                      ),
                    },
                    {
                      title: 'Download',
                      width: 80,
                      align: 'center',
                      render: (_, cat) => {
                        const g = grants[`${drawerFundId}::${cat.id}`];
                        return g?.granted ? (
                          <Checkbox
                            checked={g.downloadAllowed}
                            onChange={() => toggleDownload(drawerFundId, cat.id)}
                          />
                        ) : null;
                      },
                    },
                  ]}
                />
              </Card>
            )}

            {!drawerFundId && funds.length > 0 && (
              <Empty description="Select a fund above to set permissions" />
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
