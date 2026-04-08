import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Tag, Space, Modal, Form, Input, Select, message, Badge,
} from 'antd';
import { PlusOutlined, SendOutlined, EyeOutlined, CheckOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

export default function NoticesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [notices, setNotices] = useState([]);
  const [funds, setFunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [viewNotice, setViewNotice] = useState(null);
  const [composing, setComposing] = useState(false);
  const [form] = Form.useForm();

  const loadNotices = async () => {
    setLoading(true);
    try {
      const res = await api.get('/notices');
      if (res.ok) setNotices(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    loadNotices();
    if (isAdmin) {
      api.get('/funds').then((r) => r.json()).then(setFunds);
    }
  }, []);

  const handleCreate = async (values) => {
    setComposing(true);
    try {
      const res = await api.post('/notices', values);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success('Draft notice created');
      form.resetFields();
      setComposeOpen(false);
      loadNotices();
    } catch (err) {
      message.error(err.message);
    }
    setComposing(false);
  };

  const handleSend = async (noticeId) => {
    Modal.confirm({
      title: 'Send Notice',
      content: 'This will send the notice to all eligible recipients. This cannot be undone.',
      onOk: async () => {
        try {
          const res = await api.post(`/notices/${noticeId}/send`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          message.success(data.message);
          loadNotices();
        } catch (err) {
          message.error(err.message);
        }
      },
    });
  };

  const handleView = async (notice) => {
    setViewNotice(notice);
    // Mark as read for non-admins
    if (!isAdmin && !notice.read_at) {
      await api.post(`/notices/${notice.id}/read`);
      // Update local state
      setNotices((prev) => prev.map((n) =>
        n.id === notice.id ? { ...n, read_at: new Date().toISOString() } : n
      ));
    }
  };

  const handleAcknowledge = async (noticeId) => {
    try {
      const res = await api.post(`/notices/${noticeId}/acknowledge`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success('Notice confirmed as read');
      // Update local state
      setNotices((prev) => prev.map((n) =>
        n.id === noticeId ? { ...n, acknowledged_at: data.acknowledgedAt || new Date().toISOString() } : n
      ));
      setViewNotice((prev) => prev ? { ...prev, acknowledged_at: data.acknowledgedAt || new Date().toISOString() } : null);
    } catch (err) {
      message.error(err.message);
    }
  };

  const typeColours = {
    general: 'default',
    liquidity: 'blue',
    valuation: 'green',
    compliance: 'red',
  };

  const adminColumns = [
    {
      title: 'Subject',
      dataIndex: 'subject',
      render: (s, r) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => handleView(r)}>{s}</Button>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      width: 110,
      render: (t) => <Tag color={typeColours[t]}>{t}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (s) => <Tag color={s === 'sent' ? 'green' : 'gold'}>{s}</Tag>,
    },
    {
      title: 'Recipients',
      key: 'recipients',
      width: 180,
      render: (_, r) => r.recipient_count != null ? (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}>{r.read_count}/{r.recipient_count} read</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.ack_count || 0}/{r.recipient_count} confirmed</Text>
        </Space>
      ) : '—',
    },
    {
      title: 'Date',
      key: 'date',
      width: 150,
      render: (_, r) => dayjs(r.sent_at || r.created_at).format('DD MMM YYYY HH:mm'),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_, r) =>
        r.status === 'draft' ? (
          <Button icon={<SendOutlined />} size="small" onClick={() => handleSend(r.id)}>
            Send
          </Button>
        ) : null,
    },
  ];

  const userColumns = [
    {
      title: 'Subject',
      dataIndex: 'subject',
      render: (s, r) => (
        <Space>
          {!r.read_at && <Badge status="processing" />}
          <Button type="link" style={{ padding: 0, fontWeight: r.read_at ? 'normal' : 'bold' }} onClick={() => handleView(r)}>
            {s}
          </Button>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      width: 110,
      render: (t) => <Tag color={typeColours[t]}>{t}</Tag>,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, r) => r.acknowledged_at ? (
        <Tag icon={<CheckCircleOutlined />} color="success">Confirmed</Tag>
      ) : r.read_at ? (
        <Tag color="blue">Read</Tag>
      ) : (
        <Tag color="gold">Unread</Tag>
      ),
    },
    {
      title: 'From',
      dataIndex: 'sent_by_name',
      width: 150,
    },
    {
      title: 'Date',
      key: 'date',
      width: 150,
      render: (_, r) => dayjs(r.sent_at).format('DD MMM YYYY HH:mm'),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Notices</Title>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setComposeOpen(true)}>
            Compose Notice
          </Button>
        )}
      </div>

      <Card>
        <Table
          dataSource={notices}
          columns={isAdmin ? adminColumns : userColumns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
          size="middle"
        />
      </Card>

      {/* Compose modal */}
      <Modal
        title="Compose Notice"
        open={composeOpen}
        onCancel={() => setComposeOpen(false)}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="fundId" label="Fund (optional — leave blank for all funds)">
            <Select
              placeholder="All funds"
              allowClear
              options={funds.map((f) => ({ value: f.id, label: f.name }))}
            />
          </Form.Item>
          <Form.Item name="type" label="Type" initialValue="general">
            <Select options={[
              { value: 'general', label: 'General' },
              { value: 'liquidity', label: 'Liquidity' },
              { value: 'valuation', label: 'Valuation' },
              { value: 'compliance', label: 'Compliance' },
            ]} />
          </Form.Item>
          <Form.Item name="subject" label="Subject" rules={[{ required: true }]}>
            <Input placeholder="Q4 2025 Valuation Update" />
          </Form.Item>
          <Form.Item name="body" label="Body" rules={[{ required: true }]}>
            <TextArea rows={8} placeholder="Notice content..." />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={composing}>
                Save as Draft
              </Button>
              <Text type="secondary">You can review and send from the notices list.</Text>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* View modal */}
      <Modal
        title={viewNotice?.subject}
        open={!!viewNotice}
        onCancel={() => setViewNotice(null)}
        footer={null}
        width={600}
      >
        {viewNotice && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Tag color={typeColours[viewNotice.type]}>{viewNotice.type}</Tag>
              <Text type="secondary">
                {dayjs(viewNotice.sent_at || viewNotice.created_at).format('DD MMM YYYY HH:mm')}
              </Text>
              {viewNotice.sent_by_name && <Text type="secondary">by {viewNotice.sent_by_name}</Text>}
            </Space>
            <Card size="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
              {viewNotice.body}
            </Card>
            {!isAdmin && (
              viewNotice.acknowledged_at ? (
                <Alert
                  message={`You confirmed reading this notice on ${dayjs(viewNotice.acknowledged_at).format('DD MMM YYYY [at] HH:mm')}`}
                  type="success"
                  showIcon
                  icon={<CheckCircleOutlined />}
                />
              ) : (
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  block
                  onClick={() => handleAcknowledge(viewNotice.id)}
                >
                  I confirm I have read this notice
                </Button>
              )
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}
