import { useEffect, useState } from 'react';
import { Table, Typography, Card, Select, Space, Tag, Input } from 'antd';
import { api } from '../../api/client.js';
import dayjs from 'dayjs';

const { Title } = Typography;
const { Search } = Input;

const actionColours = {
  'login.success': 'green',
  'login.failed': 'red',
  'logout': 'default',
  'document.uploaded': 'blue',
  'document.downloaded': 'cyan',
  'document.archived': 'orange',
  'invite.sent': 'purple',
  'invite.accepted': 'green',
  'grant.created': 'blue',
  'grant.revoked': 'red',
  'grant.bulk_update': 'blue',
  'user.updated': 'orange',
  'mfa.enabled': 'green',
  'password.changed': 'gold',
  'notice.sent': 'purple',
};

export default function AuditPage() {
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState([]);
  const [filterAction, setFilterAction] = useState(null);

  useEffect(() => {
    api.get('/audit/actions').then((r) => r.json()).then(setActions);
  }, []);

  useEffect(() => {
    loadAudit();
  }, [page, filterAction]);

  const loadAudit = async () => {
    setLoading(true);
    try {
      let url = `/audit?page=${page}&limit=30`;
      if (filterAction) url += `&action=${filterAction}`;
      const res = await api.get(url);
      const result = await res.json();
      setData(result.data);
      setTotal(result.total);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const columns = [
    {
      title: 'Time',
      dataIndex: 'createdAt',
      width: 170,
      render: (t) => dayjs(t).format('DD MMM YYYY HH:mm:ss'),
    },
    {
      title: 'Action',
      dataIndex: 'action',
      width: 160,
      render: (a) => <Tag color={actionColours[a] || 'default'}>{a}</Tag>,
    },
    { title: 'User', dataIndex: 'userName', width: 150 },
    { title: 'Email', dataIndex: 'userEmail', width: 200 },
    {
      title: 'Resource',
      key: 'resource',
      width: 120,
      render: (_, r) => r.resource ? `${r.resource}` : '—',
    },
    {
      title: 'Detail',
      dataIndex: 'detail',
      ellipsis: true,
      render: (d) => d ? JSON.stringify(d) : '—',
    },
    { title: 'IP', dataIndex: 'ipAddress', width: 130 },
  ];

  return (
    <div>
      <Title level={3}>Audit Log</Title>

      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="Filter by action"
          allowClear
          style={{ width: 220 }}
          onChange={(v) => { setFilterAction(v); setPage(1); }}
          options={actions.map((a) => ({ value: a, label: a }))}
        />
      </Space>

      <Card>
        <Table
          dataSource={data}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            current: page,
            total,
            pageSize: 30,
            onChange: setPage,
            showTotal: (t) => `${t} entries`,
          }}
        />
      </Card>
    </div>
  );
}
