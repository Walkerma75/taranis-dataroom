import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Select, Progress, Tooltip, Modal, Form, Input, message, Badge,
} from 'antd';
import {
  PlusOutlined, CheckCircleTwoTone, CloseCircleTwoTone, DownloadOutlined,
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

/**
 * The due diligence pipeline, per fund.
 *
 * The two gate columns are the point of this page: a company cannot be
 * activated until both are ticked, and seeing which one is missing at a glance
 * is what stops someone chasing the wrong thing.
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

  const columns = [
    {
      title: 'Company',
      dataIndex: 'legalName',
      render: (name, row) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/admin/companies/${row.id}`)}>
            {name}
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.fundName}</Text>
        </Space>
      ),
    },
    {
      title: 'NDA',
      key: 'nda',
      width: 70,
      align: 'center',
      render: (_, row) => gate(row.ndaExecutedAt, 'Executed NDA'),
    },
    {
      title: 'IEMS',
      key: 'iems',
      width: 70,
      align: 'center',
      render: (_, row) => gate(row.iemsScreenedAt, 'IEMS screen'),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
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
      title: 'Awaiting review',
      dataIndex: 'awaitingReview',
      width: 130,
      align: 'center',
      render: (n) => (n > 0 ? <Badge count={n} color="#C9A84C" /> : <Text type="secondary">0</Text>),
    },
    {
      title: 'Attention',
      dataIndex: 'attentionCount',
      width: 100,
      align: 'center',
      render: (n) => (n > 0 ? <Badge count={n} color="#B54A32" /> : <Text type="secondary">0</Text>),
    },
    {
      title: 'Last activity',
      dataIndex: 'lastActivity',
      width: 170,
      render: (d) => (d ? formatUtc(d) : <Text type="secondary">None</Text>),
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

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Due diligence pipeline</Title>
        <Paragraph type="secondary">
          Companies under due diligence. A company cannot be activated until both the executed NDA
          and the IEMS screening dates are recorded.
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
        <Table
          rowKey="id"
          columns={columns}
          dataSource={companies}
          loading={loading}
          pagination={false}
          locale={{ emptyText: 'No companies yet.' }}
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
