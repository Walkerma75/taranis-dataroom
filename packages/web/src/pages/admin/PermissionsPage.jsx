import { useEffect, useState } from 'react';
import {
  Typography, Card, Select, Table, Checkbox, Button, message, Space, Tag, Empty, Divider,
} from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { api } from '../../api/client.js';

const { Title, Text } = Typography;

export default function PermissionsPage() {
  const [users, setUsers] = useState([]);
  const [funds, setFunds] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [grants, setGrants] = useState({}); // { `${fundId}-${catId}`: { granted, downloadAllowed } }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedUserData, setSelectedUserData] = useState(null);
  const [selectedFundId, setSelectedFundId] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/users').then((r) => r.json()),
      api.get('/funds').then((r) => r.json()),
      api.get('/funds/categories').then((r) => r.json()),
    ]).then(([u, f, c]) => {
      setUsers(u);
      setFunds(f);
      setCategories(c);
    });
  }, []);

  const loadUserGrants = async (userId) => {
    setSelectedUser(userId);
    const userData = users.find((u) => u.id === userId);
    setSelectedUserData(userData || null);
    setSelectedFundId(null);
    setLoading(true);
    try {
      const res = await api.get(`/grants?userId=${userId}`);
      const data = await res.json();
      const map = {};
      data.forEach((g) => {
        map[`${g.fundId}-${g.categoryId}`] = {
          granted: true,
          downloadAllowed: g.downloadAllowed,
        };
      });
      setGrants(map);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const toggleGrant = (fundId, catId) => {
    const key = `${fundId}-${catId}`;
    setGrants((prev) => {
      const existing = prev[key];
      if (existing?.granted) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      const downloadDefault = !!(selectedUserData?.capabilities?.canDownloadDocuments);
      return { ...prev, [key]: { granted: true, downloadAllowed: downloadDefault } };
    });
  };

  const toggleDownload = (fundId, catId) => {
    const key = `${fundId}-${catId}`;
    setGrants((prev) => ({
      ...prev,
      [key]: { ...prev[key], downloadAllowed: !prev[key]?.downloadAllowed },
    }));
  };

  const selectAllForFund = (fundId) => {
    const downloadDefault = !!(selectedUserData?.capabilities?.canDownloadDocuments);
    setGrants((prev) => {
      const next = { ...prev };
      categories.forEach((cat) => {
        const key = `${fundId}-${cat.id}`;
        next[key] = next[key]?.granted ? next[key] : { granted: true, downloadAllowed: downloadDefault };
      });
      return next;
    });
  };

  const clearAllForFund = (fundId) => {
    setGrants((prev) => {
      const next = { ...prev };
      categories.forEach((cat) => {
        delete next[`${fundId}-${cat.id}`];
      });
      return next;
    });
  };

  const saveGrants = async () => {
    setSaving(true);
    try {
      const grantList = Object.entries(grants)
        .filter(([, v]) => v.granted)
        .map(([key, v]) => {
          const [fundId, categoryId] = key.split('-');
          return { fundId, categoryId, downloadAllowed: v.downloadAllowed };
        });

      const res = await api.post('/grants/bulk', { userId: selectedUser, grants: grantList });
      if (!res.ok) throw new Error('Failed to save');
      message.success('Permissions saved');
    } catch (err) {
      message.error(err.message);
    }
    setSaving(false);
  };

  return (
    <div>
      <Title level={3}>Permission Matrix</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        Select a user, then tick the fund/category combinations they should have access to.
      </Text>

      <Select
        showSearch
        placeholder="Select a user..."
        style={{ width: 400, marginBottom: 24 }}
        onChange={loadUserGrants}
        optionFilterProp="label"
        options={users.map((u) => ({
          value: u.id,
          label: `${u.displayName} (${u.email})`,
        }))}
      />

      {selectedUser && (
        <>
          <Select
            placeholder="Select a fund..."
            style={{ width: 400, marginBottom: 16 }}
            value={selectedFundId}
            onChange={setSelectedFundId}
            options={funds.map((f) => {
              const grantedCount = categories.filter((c) => grants[`${f.id}-${c.id}`]?.granted).length;
              return {
                value: f.id,
                label: `${f.name}${grantedCount > 0 ? ` (${grantedCount} categories)` : ''}`,
              };
            })}
          />

          {selectedFundId && (
            <Card
              title={funds.find((f) => f.id === selectedFundId)?.name}
              size="small"
              style={{ marginBottom: 16 }}
              extra={
                <Space>
                  <Button size="small" onClick={() => selectAllForFund(selectedFundId)}>Select All</Button>
                  <Button size="small" onClick={() => clearAllForFund(selectedFundId)}>Clear</Button>
                </Space>
              }
            >
              <Table
                dataSource={categories}
                rowKey="id"
                pagination={false}
                size="small"
                loading={loading}
                columns={[
                  { title: 'Category', dataIndex: 'name' },
                  {
                    title: 'Access',
                    width: 80,
                    align: 'center',
                    render: (_, cat) => (
                      <Checkbox
                        checked={!!grants[`${selectedFundId}-${cat.id}`]?.granted}
                        onChange={() => toggleGrant(selectedFundId, cat.id)}
                      />
                    ),
                  },
                  {
                    title: 'Download',
                    width: 80,
                    align: 'center',
                    render: (_, cat) => {
                      const g = grants[`${selectedFundId}-${cat.id}`];
                      return g?.granted ? (
                        <Checkbox
                          checked={g.downloadAllowed}
                          onChange={() => toggleDownload(selectedFundId, cat.id)}
                        />
                      ) : null;
                    },
                  },
                ]}
              />
            </Card>
          )}

          {!selectedFundId && <Empty description="Select a fund above to set permissions" />}

          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={saveGrants}
            loading={saving}
            size="large"
            style={{ marginTop: 16 }}
          >
            Save Permissions
          </Button>
        </>
      )}

      {!selectedUser && <Empty description="Select a user to manage permissions" />}
    </div>
  );
}
