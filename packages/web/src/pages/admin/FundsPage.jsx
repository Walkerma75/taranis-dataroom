import { useEffect, useState } from 'react';
import { Table, Button, Tag, Typography, Modal, Form, Input, Select, message, Card, Space } from 'antd';
import { PlusOutlined, EditOutlined, FileTextOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasCap } from '../../components/AppLayout.jsx';

const { Title } = Typography;
const { TextArea } = Input;

export default function FundsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [funds, setFunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingFund, setEditingFund] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canEdit = hasCap(user, 'canManageFunds');

  const loadFunds = async () => {
    setLoading(true);
    try {
      const res = await api.get('/funds');
      if (res.ok) setFunds(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadFunds(); }, []);

  const openCreate = () => {
    setEditingFund(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (fund) => {
    setEditingFund(fund);
    form.setFieldsValue(fund);
    setModalOpen(true);
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      let res;
      if (editingFund) {
        res = await api.patch(`/funds/${editingFund.id}`, values);
      } else {
        res = await api.post('/funds', values);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(editingFund ? 'Fund updated' : 'Fund created');
      setModalOpen(false);
      loadFunds();
    } catch (err) {
      message.error(err.message);
    }
    setSaving(false);
  };

  const viewDocuments = (fund) => {
    navigate(`/documents?fundId=${fund.id}`);
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', sorter: (a, b) => a.name.localeCompare(b.name) },
    { title: 'Slug', dataIndex: 'slug', width: 120 },
    { title: 'Description', dataIndex: 'description', ellipsis: true },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (s) => <Tag color={s === 'active' ? 'green' : s === 'draft' ? 'gold' : 'default'}>{s}</Tag>,
      width: 100,
    },
    { title: 'Documents', dataIndex: 'docCount', width: 100, align: 'center' },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_, record) => (
        <Space>
          <Button
            icon={<FileTextOutlined />}
            size="small"
            onClick={() => viewDocuments(record)}
          >
            Documents
          </Button>
          {canEdit && (
            <Button icon={<EditOutlined />} size="small" onClick={() => openEdit(record)} />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Funds</Title>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Fund
          </Button>
        )}
      </div>

      <Card>
        <Table dataSource={funds} columns={columns} rowKey="id" loading={loading} pagination={false} size="middle" />
      </Card>

      <Modal
        title={editingFund ? 'Edit Fund' : 'Create Fund'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="name" label="Fund Name" rules={[{ required: true }]}>
            <Input placeholder="Taranis New Fund" />
          </Form.Item>
          {!editingFund && (
            <Form.Item name="slug" label="Slug" rules={[{ required: true }]}>
              <Input placeholder="new-fund" />
            </Form.Item>
          )}
          <Form.Item name="description" label="Description">
            <TextArea rows={3} />
          </Form.Item>
          {editingFund && (
            <Form.Item name="status" label="Status">
              <Select options={[
                { value: 'active', label: 'Active' },
                { value: 'draft', label: 'Draft' },
                { value: 'closed', label: 'Closed' },
              ]} />
            </Form.Item>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving} block>
              {editingFund ? 'Save Changes' : 'Create Fund'}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
