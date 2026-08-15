import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Select, Progress, Tooltip, Modal, Form, Input, message, Badge,
} from 'antd';
import {
  PlusOutlined, CheckCircleTwoTone, CloseCircleTwoTone, DownloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, apiFetch } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { COMPANY_STATUS_LABELS, formatUtc } from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

const STATUS_COLOURS = {
  pending: '#8C8C8C',
  active: '#3A5247',
  suspended: '#C9A84C',
  offboarded: '#BFBFBF',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sort key for a timestamp. No activity sorts as the oldest thing there is. */
const timeKey = (value) => (value ? new Date(value).getTime() : 0);

/**
 * Completion as a fraction, with an unseeded company below zero per cent.
 *
 * A company with no checklist has not made zero progress, it has not started
 * the process, and sorting it in among the companies sitting at 0 of 146 would
 * hide the one thing an admin needs to see about it.
 */
const progressKey = (row) => (row.itemCount ? row.completedCount / row.itemCount : -1);

/** Which of the four disjoint progress buckets a row is in. */
const progressBucket = (row) => {
  if (!row.itemCount) return 'unseeded';
  if (row.completedCount === 0) return 'not_started';
  if (row.completedCount >= row.itemCount) return 'complete';
  return 'in_progress';
};

/**
 * Which age band the last activity falls in. The bands are disjoint on purpose:
 * Ant Design ORs the ticked values together, so overlapping bands would make
 * "last 7 days" plus "last 30 days" mean the same as "last 30 days" alone and
 * leave the admin unsure which tick did anything.
 */
const activityBucket = (value, now) => {
  if (!value) return 'none';
  const age = now - new Date(value).getTime();
  if (age <= 7 * DAY_MS) return 'recent';
  if (age <= 30 * DAY_MS) return 'month';
  return 'stale';
};

/**
 * A free-text column filter, for the columns where a fixed tick list would be
 * as long as the table itself.
 */
const textFilter = (placeholder, valueOf) => ({
  filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
    <div style={{ padding: 8 }} onKeyDown={(e) => e.stopPropagation()}>
      <Input
        autoFocus
        placeholder={placeholder}
        value={selectedKeys[0]}
        onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
        onPressEnter={() => confirm()}
        style={{ width: 220, marginBottom: 8, display: 'block' }}
      />
      <Space>
        <Button type="primary" size="small" onClick={() => confirm()}>Filter</Button>
        <Button size="small" onClick={() => { clearFilters(); confirm(); }}>Clear</Button>
      </Space>
    </div>
  ),
  filterIcon: (filtered) => <SearchOutlined style={{ color: filtered ? '#C9A84C' : undefined }} />,
  onFilter: (value, row) => valueOf(row).toLowerCase().includes(String(value).toLowerCase()),
});

/** The two gate columns filter and sort the same way, so they are built once. */
const gateColumn = (title, key, field, label, gate) => ({
  title,
  key,
  width: 80,
  align: 'center',
  render: (_, row) => gate(row[field], label),
  sorter: (a, b) => timeKey(a[field]) - timeKey(b[field]),
  filters: [
    { text: 'Recorded', value: 'yes' },
    { text: 'Not recorded', value: 'no' },
  ],
  onFilter: (value, row) => (value === 'yes' ? !!row[field] : !row[field]),
});

/**
 * The two badge columns. Sorting one descending is how an admin asks "who is
 * waiting on me", so the tick list is only ever the two answers that matter.
 */
const countColumn = (title, key, width) => ({
  title,
  key,
  dataIndex: key,
  width,
  align: 'center',
  sorter: (a, b) => a[key] - b[key],
  filters: [
    { text: 'One or more', value: 'some' },
    { text: 'None', value: 'none' },
  ],
  onFilter: (value, row) => (value === 'some' ? row[key] > 0 : row[key] === 0),
});

const DEFAULT_SORT = { columnKey: 'lastActivity', order: 'descend' };

/**
 * The due diligence pipeline, per fund.
 *
 * The two gate columns are the point of this page: a company cannot be
 * activated until both are ticked, and seeing which one is missing at a glance
 * is what stops someone chasing the wrong thing.
 *
 * It opens on newest activity first, because the question an admin arrives with
 * is almost always what has moved since they last looked. Every column then
 * sorts both ways and filters from its own header, all of it client side: this
 * list is one row per counterparty, so the whole thing is already in the
 * browser and a round trip per tick would buy nothing.
 */
export default function PipelinePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [companies, setCompanies] = useState([]);
  const [funds, setFunds] = useState([]);
  const [fundId, setFundId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  // Filtering and sorting are held here rather than left to the table, so that
  // Clear can put every column back at once. An admin who has narrowed three
  // columns and lost the row they were looking for should not have to remember
  // which three.
  const [filteredInfo, setFilteredInfo] = useState({});
  const [sortedInfo, setSortedInfo] = useState(DEFAULT_SORT);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/companies${fundId ? `?fundId=${fundId}` : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setCompanies(body);
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [fundId]);
  useEffect(() => {
    api.get('/funds').then((r) => r.json()).then(setFunds).catch(() => {});
  }, []);

  const create = async (values) => {
    setSaving(true);
    try {
      const res = await api.post('/companies', {
        ...values,
        emailDomains: (values.emailDomains || '')
          .split(',').map((d) => d.trim()).filter(Boolean),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('Company created. Record the NDA and IEMS dates before activating it.');
      form.resetFields();
      setOpen(false);
      load();
      navigate(`/admin/companies/${body.id}`);
    } catch (err) {
      message.error(err.message);
    }
    setSaving(false);
  };

  const download = async (companyId, format, name) => {
    try {
      const res = await apiFetch(`/companies/${companyId}/export?format=${format}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name} ${format === 'gaps' ? 'GAPS' : 'PRE-FILLED'}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
  };

  const gate = (value, label) => (
    <Tooltip title={value ? `${label} recorded ${formatUtc(value)}` : `${label} not recorded`}>
      {value
        ? <CheckCircleTwoTone twoToneColor="#3A5247" />
        : <CloseCircleTwoTone twoToneColor="#B54A32" />}
    </Tooltip>
  );

  // Fixed once per render, so that every row lands in the same band however
  // long the admin leaves the page open.
  const now = Date.now();

  const columns = [
    {
      title: 'Company',
      key: 'legalName',
      dataIndex: 'legalName',
      render: (name, row) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/admin/companies/${row.id}`)}>
            {name}
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.fundName}</Text>
        </Space>
      ),
      sorter: (a, b) => a.legalName.localeCompare(b.legalName),
      // The fund is in this cell as well as in the header filter, so searching
      // it here finds what the eye can already see in the column.
      ...textFilter('Company or fund', (row) => `${row.legalName} ${row.fundName || ''}`),
    },
    gateColumn('NDA', 'nda', 'ndaExecutedAt', 'Executed NDA', gate),
    gateColumn('IEMS', 'iems', 'iemsScreenedAt', 'IEMS screen', gate),
    {
      title: 'Status',
      key: 'status',
      dataIndex: 'status',
      width: 130,
      sorter: (a, b) => COMPANY_STATUS_LABELS[a.status].localeCompare(COMPANY_STATUS_LABELS[b.status]),
      filters: Object.entries(COMPANY_STATUS_LABELS).map(([value, text]) => ({ text, value })),
      onFilter: (value, row) => row.status === value,
      render: (status, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={STATUS_COLOURS[status]} style={{ color: '#fff', borderColor: 'transparent' }}>
            {COMPANY_STATUS_LABELS[status]}
          </Tag>
          {status === 'pending' && !row.canActivate && (
            <Text type="secondary" style={{ fontSize: 11 }}>Gates outstanding</Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 180,
      sorter: (a, b) => progressKey(a) - progressKey(b),
      filters: [
        { text: 'Complete', value: 'complete' },
        { text: 'In progress', value: 'in_progress' },
        { text: 'Not started', value: 'not_started' },
        { text: 'Not seeded', value: 'unseeded' },
      ],
      onFilter: (value, row) => progressBucket(row) === value,
      render: (_, row) => (
        row.itemCount === 0
          ? <Text type="secondary">Not seeded</Text>
          : (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Progress
                percent={Math.round((row.completedCount / row.itemCount) * 100)}
                size="small"
                strokeColor="#3A5247"
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.completedCount} of {row.itemCount} completed
              </Text>
            </Space>
          )
      ),
    },
    {
      ...countColumn('Awaiting review', 'awaitingReview', 130),
      render: (n) => (n > 0 ? <Badge count={n} color="#C9A84C" /> : <Text type="secondary">0</Text>),
    },
    {
      ...countColumn('Attention', 'attentionCount', 100),
      render: (n) => (n > 0 ? <Badge count={n} color="#B54A32" /> : <Text type="secondary">0</Text>),
    },
    {
      title: 'Last activity',
      key: 'lastActivity',
      dataIndex: 'lastActivity',
      width: 170,
      render: (d) => (d ? formatUtc(d) : <Text type="secondary">None</Text>),
      sorter: (a, b) => timeKey(a.lastActivity) - timeKey(b.lastActivity),
      filters: [
        { text: 'Last 7 days', value: 'recent' },
        { text: '7 to 30 days ago', value: 'month' },
        { text: 'More than 30 days ago', value: 'stale' },
        { text: 'No activity', value: 'none' },
      ],
      onFilter: (value, row) => activityBucket(row.lastActivity, now) === value,
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_, row) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => download(row.id, 'prefilled', row.legalName)}
          >
            PRE-FILLED
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => download(row.id, 'gaps', row.legalName)}
          >
            GAPS
          </Button>
        </Space>
      ),
    },
  ];

  /**
   * The columns as the table takes them: controlled filter and sort state, and
   * two sort directions rather than three.
   *
   * A third click would clear the sort rather than restore the default, which
   * leaves the table in whatever order the server happened to send and looks
   * like a bug. Clear filters and sorting is the way back.
   */
  const tableColumns = columns.map((col) => ({
    ...col,
    ...(col.filters || col.filterDropdown
      ? { filteredValue: filteredInfo[col.key] || null }
      : {}),
    ...(col.sorter
      ? {
        sortOrder: sortedInfo?.columnKey === col.key ? sortedInfo.order : null,
        sortDirections: ['ascend', 'descend'],
      }
      : {}),
  }));

  const onTableChange = (_pagination, filters, sorter) => {
    setFilteredInfo(filters);
    setSortedInfo(Array.isArray(sorter) ? sorter[0] : sorter);
  };

  const clearAll = () => {
    setFilteredInfo({});
    setSortedInfo(DEFAULT_SORT);
  };

  // The same predicates the table applies, so the count cannot disagree with
  // the rows underneath it.
  const visibleRows = companies.filter((row) => columns.every((col) => {
    const picked = filteredInfo[col.key];
    if (!picked || !picked.length || !col.onFilter) return true;
    return picked.some((value) => col.onFilter(value, row));
  }));
  const filtering = Object.values(filteredInfo).some((v) => v && v.length);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Due diligence pipeline</Title>
        <Paragraph type="secondary">
          Every company under due diligence, and where a new one is added. A company cannot be
          activated until both the executed NDA and the IEMS screening dates are recorded, and its
          users are invited from its own Users tab once it exists.
        </Paragraph>
      </div>

      <Card
        extra={(
          <Space>
            <Select
              allowClear
              placeholder="All funds"
              style={{ width: 220 }}
              value={fundId}
              onChange={setFundId}
              options={funds.map((f) => ({ value: f.id, label: f.name }))}
            />
            {isAdmin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                Add a company
              </Button>
            )}
          </Space>
        )}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8,
        }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {filtering
              ? `Showing ${visibleRows.length} of ${companies.length} companies`
              : 'Newest activity first. Every column sorts and filters from its own header.'}
          </Text>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={clearAll}>
            Clear filters and sorting
          </Button>
        </div>

        <Table
          rowKey="id"
          columns={tableColumns}
          dataSource={companies}
          loading={loading}
          pagination={false}
          onChange={onTableChange}
          locale={{
            emptyText: filtering
              ? 'No company matches these filters.'
              : (isAdmin
                ? 'No companies yet. Use Add a company to create the first one.'
                : 'No companies yet.'),
          }}
        />
      </Card>

      <Modal
        title="Add a company"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Create"
        confirmLoading={saving}
      >
        <Paragraph type="secondary">
          The company is created as pending and sees nothing until it is activated.
        </Paragraph>
        <Form form={form} layout="vertical" onFinish={create} requiredMark={false}>
          <Form.Item name="fundId" label="Fund" rules={[{ required: true, message: 'Please choose a fund' }]}>
            <Select options={funds.map((f) => ({ value: f.id, label: f.name }))} />
          </Form.Item>
          <Form.Item name="legalName" label="Legal name" rules={[{ required: true, message: 'Please enter the legal name' }]}>
            <Input placeholder="Example Biotech Limited" />
          </Form.Item>
          <Form.Item name="jurisdiction" label="Jurisdiction">
            <Input placeholder="Saudi Arabia" />
          </Form.Item>
          <Form.Item
            name="emailDomains"
            label="Email domains"
            extra="Comma separated. Used to flag, never to block, a nomination from another domain."
          >
            <Input placeholder="examplebio.com, examplebio.sa" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
