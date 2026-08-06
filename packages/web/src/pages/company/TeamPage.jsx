import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Modal, Form, Input, Select, message, Popconfirm, Alert, Spin,
} from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { COMPANY_ROLE_LABELS, formatUtc } from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * The company's own team.
 *
 * A nomination does not create access. Taranis approves it and issues the
 * invitation, which is why a nominated person shows as "awaiting Taranis"
 * rather than as a member.
 */
export default function TeamPage() {
  const { user } = useAuth();
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/company/team');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setTeam(body);
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const nominate = async (values) => {
    setSaving(true);
    try {
      const res = await api.post('/company/nominations', values);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success(body.message);
      if (body.domainMatched === false) {
        message.info('This email is not on your registered domain, so Taranis will check it before approving.');
      }
      form.resetFields();
      setOpen(false);
      load();
    } catch (err) {
      message.error(err.message);
    }
    setSaving(false);
  };

  const deactivate = async (userId) => {
    try {
      const res = await api.patch(`/company/users/${userId}/deactivate`, {});
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('Access removed');
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'displayName',
      render: (name, row) => (
        <Space>
          <Text>{name}</Text>
          {row.isPrimary && <Tag color="#2C3E35">Primary contact</Tag>}
        </Space>
      ),
    },
    { title: 'Email', dataIndex: 'email' },
    {
      title: 'Role',
      dataIndex: 'companyRole',
      render: (role) => COMPANY_ROLE_LABELS[role] || role,
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, row) => {
        if (row.deactivatedAt) return <Tag>Access removed</Tag>;
        if (!row.approved) return <Tag color="#C9A84C">Awaiting Taranis</Tag>;
        if (row.accountStatus === 'invited') return <Tag color="#8C8C8C">Invited</Tag>;
        return <Tag color="#3A5247">Active</Tag>;
      },
    },
    { title: 'Joined', dataIndex: 'joinedAt', render: (d) => formatUtc(d) },
    {
      title: '',
      key: 'actions',
      width: 140,
      render: (_, row) => (
        !row.deactivatedAt && row.userId !== user?.id ? (
          <Popconfirm
            title="Remove this person's access?"
            description="They will be signed out immediately."
            onConfirm={() => deactivate(row.userId)}
            okText="Remove"
            cancelText="Cancel"
          >
            <Button type="link" danger>Remove access</Button>
          </Popconfirm>
        ) : null
      ),
    },
  ];

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Your team</Title>
        <Paragraph type="secondary">
          Everyone at {user?.companyName} with access to this workspace. Nominate a colleague and
          Taranis will approve the nomination and send them an invitation.
        </Paragraph>
      </div>

      <Alert
        type="info"
        showIcon
        message="Everyone here needs two-factor authentication"
        description="Anyone you nominate will be asked to set up an authenticator app the first
          time they sign in. They cannot see anything in this workspace until they have."
      />

      <Card
        extra={(
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setOpen(true)}>
            Nominate a colleague
          </Button>
        )}
      >
        <Table rowKey="membershipId" columns={columns} dataSource={team} pagination={false} />
      </Card>

      <Modal
        title="Nominate a colleague"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Send nomination"
        confirmLoading={saving}
      >
        <Paragraph type="secondary">
          Taranis reviews every nomination before access is granted. You will need to pass on the
          invitation link they issue.
        </Paragraph>
        <Form form={form} layout="vertical" onFinish={nominate} requiredMark={false}>
          <Form.Item
            name="displayName"
            label="Full name"
            rules={[{ required: true, message: 'Please enter their name' }]}
          >
            <Input placeholder="Jane Smith" />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email address"
            rules={[
              { required: true, message: 'Please enter their email address' },
              { type: 'email', message: 'Please enter a valid email address' },
            ]}
          >
            <Input placeholder="jane.smith@example.com" />
          </Form.Item>
          <Form.Item name="companyRole" label="Role" initialValue="company_contributor">
            <Select
              options={[
                { value: 'company_admin', label: 'Administrator, can upload and submit formally' },
                { value: 'company_contributor', label: 'Contributor, can upload but not submit' },
                { value: 'company_viewer', label: 'Viewer, can see the checklist only' },
              ]}
            />
          </Form.Item>
          <Form.Item name="note" label="Note for Taranis (optional)">
            <Input.TextArea rows={2} placeholder="For example: our external counsel on this transaction" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
