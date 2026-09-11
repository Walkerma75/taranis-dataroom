import { useEffect, useState, useCallback } from 'react';
import {
  Typography, Table, Button, Space, Tag, Alert, message, Modal, Form, Select, DatePicker, Checkbox,
  Popconfirm, Drawer, Tooltip,
} from 'antd';
import { KeyOutlined, EditOutlined, HistoryOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../../api/client.js';
import { formatUtc } from '../company/irlDisplay.js';

const { Text, Paragraph } = Typography;

const LEVEL_OPTIONS = [
  { value: 'readonly', label: 'Read only' },
  { value: 'reviewer', label: 'Reviewer, can set statuses and notes' },
];

const ALL = '__all__';

/**
 * The Access tab: who outside the admin group can see this company, what of
 * it, until when, and what they have opened (HANDOVER-CW028 §3.4).
 *
 * Restricted material is never in the gift of a grant, whatever is chosen
 * here; that is the item flag on the Checklist tab and the per-file override
 * on the Files tab. This tab decides scope and duration for a named person,
 * and records the two confirmations that make it proper to give.
 */
export default function AccessTab({ company, items }) {
  const [grants, setGrants] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState(null);         // 'give' | 'edit'
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const [historyGrant, setHistoryGrant] = useState(null);
  const [history, setHistory] = useState([]);

  const sections = [...new Set(items.map((i) => i.section))];

  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([
        api.get(`/companies/${company.id}/access`),
        api.get(`/companies/${company.id}/access/candidates`),
      ]);
      const gb = await g.json();
      const cb = await c.json();
      if (!g.ok) throw new Error(gb.error);
      if (!c.ok) throw new Error(cb.error);
      setGrants(gb);
      setCandidates(cb);
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  }, [company.id]);

  useEffect(() => { load(); }, [load]);

  const openGive = () => {
    setMode('give');
    setTarget(null);
    form.resetFields();
    form.setFieldsValue({
      level: 'readonly',
      sections: [ALL],
      accessUntil: dayjs().add(30, 'day'),
      confidentiality: false,
      ndaPermits: false,
    });
  };

  const openEdit = (grant) => {
    setMode('edit');
    setTarget(grant);
    form.resetFields();
    form.setFieldsValue({
      userId: grant.userId,
      level: grant.level,
      sections: grant.sections || [ALL],
      accessUntil: grant.expiresAt ? dayjs(grant.expiresAt) : dayjs().add(30, 'day'),
    });
  };

  const close = () => { setMode(null); setTarget(null); };

  const chosenPerson = Form.useWatch('userId', form);
  const person = candidates.find((c) => c.id === chosenPerson) || (target ? { displayName: target.displayName, hasFundGrant: true, mfaEnabled: true } : null);
  const personName = person?.displayName || 'This person';

  const save = async () => {
    const values = await form.validateFields();
    const scoped = (values.sections || []).filter((s) => s !== ALL);
    const body = {
      level: values.level,
      sections: scoped.length ? scoped : 'all',
      accessUntil: values.accessUntil.endOf('day').toISOString(),
    };
    setSaving(true);
    try {
      let res;
      if (mode === 'edit') {
        res = await api.patch(`/companies/${company.id}/access/${target.id}`, body);
      } else {
        res = await api.post(`/companies/${company.id}/access`, {
          ...body,
          userId: values.userId,
          attestations: { confidentiality: values.confidentiality === true, ndaPermits: values.ndaPermits === true },
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(data.message || 'Saved');
      if (data.warning) message.warning(data.warning, 8);
      close();
      load();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (grant) => {
    try {
      const res = await api.delete(`/companies/${company.id}/access/${grant.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(data.message);
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  const openHistory = async (grant) => {
    setHistoryGrant(grant);
    setHistory([]);
    try {
      const res = await api.get(`/companies/${company.id}/access/${grant.id}/downloads`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setHistory(data);
    } catch (err) {
      message.error(err.message);
    }
  };

  const columns = [
    {
      title: 'Person',
      dataIndex: 'displayName',
      render: (name, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.email} · {row.role}</Text>
        </Space>
      ),
    },
    {
      title: 'Level',
      dataIndex: 'level',
      width: 110,
      render: (l) => (l === 'reviewer' ? <Tag color="#3A5247" style={{ color: '#fff', borderColor: 'transparent' }}>Reviewer</Tag> : <Tag>Read only</Tag>),
    },
    {
      title: 'Sections',
      dataIndex: 'sections',
      render: (s) => (s ? (
        <Tooltip title={s.join('; ')}>
          <Tag icon={<KeyOutlined />}>{s.length} of {sections.length}</Tag>
        </Tooltip>
      ) : <Text>All sections</Text>),
    },
    {
      title: 'Access until',
      dataIndex: 'expiresAt',
      width: 200,
      render: (d, row) => {
        if (row.needsEndDate) {
          return <Tag icon={<WarningOutlined />} color="#C9A84C" style={{ color: '#fff', borderColor: 'transparent' }}>No end date, set one</Tag>;
        }
        if (row.expired) return <Tag color="#8C8C8C" style={{ color: '#fff', borderColor: 'transparent' }}>Expired {formatUtc(d)}</Tag>;
        return <Text>{formatUtc(d)}</Text>;
      },
    },
    {
      title: 'Granted',
      key: 'granted',
      width: 200,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>{formatUtc(row.grantedAt)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>by {row.grantedBy}</Text>
        </Space>
      ),
    },
    {
      title: 'Downloads',
      key: 'downloads',
      width: 170,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Button type="link" style={{ padding: 0, height: 'auto' }} icon={<HistoryOutlined />} onClick={() => openHistory(row)}>
            {row.downloads?.count || 0}
          </Button>
          {row.downloads?.last && (
            <Text type="secondary" style={{ fontSize: 12 }}>last {formatUtc(row.downloads.last)}</Text>
          )}
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 170,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm
            title="Remove this person's access?"
            description="They stop seeing this company at once. The record of what they opened is kept."
            onConfirm={() => remove(row)}
            okText="Remove"
          >
            <Button size="small" danger>Remove</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Restricted items stay with admins whatever is granted here"
        description="A grant decides which sections a person may see and until when. Items marked Restricted on the Checklist tab, files restricted on the Files tab, and Additional Documents are never shown to anyone with a grant, at any level. Everything the person opens is on the record."
      />

      <Button type="primary" icon={<KeyOutlined />} onClick={openGive}>Give access</Button>

      <Table
        rowKey="id"
        dataSource={grants}
        columns={columns}
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: 'Nobody outside the admin group has access to this company.' }}
        rowClassName={(row) => (row.expired ? 'taranis-row-withdrawn' : '')}
      />

      <Modal
        title={mode === 'edit' ? `Edit access for ${target?.displayName || ''}` : 'Give access to this company'}
        open={!!mode}
        onCancel={close}
        onOk={save}
        okText={mode === 'edit' ? 'Save' : 'Give access'}
        confirmLoading={saving}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          {mode === 'give' && (
            <Form.Item
              name="userId"
              label="Person"
              extra="Active advisers and viewers only. Investors and company users cannot be given access."
              rules={[{ required: true, message: 'Choose a person' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Choose a person"
                options={candidates.map((c) => ({
                  value: c.id,
                  label: `${c.displayName} (${c.email}, ${c.role})`,
                }))}
              />
            </Form.Item>
          )}
          {person && person.hasFundGrant === false && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${personName} holds no document access on ${company.fundName}`}
              description="They can still be given this company. Check that is intended."
            />
          )}
          {person && person.mfaEnabled === false && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${personName} has not set up two-step verification`}
              description="They will be asked to set it up at their next sign-in and cannot see company information until they have."
            />
          )}
          <Form.Item name="level" label="Level">
            <Select options={LEVEL_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="sections"
            label="Sections"
            extra="All, or a pick from this company's checklist sections."
            rules={[{ required: true, message: 'Choose All or at least one section' }]}
          >
            <Select
              mode="multiple"
              options={[{ value: ALL, label: 'All sections' }, ...sections.map((s) => ({ value: s, label: s }))]}
              onChange={(vals) => {
                // Choosing All clears specific picks; choosing a section clears All.
                if (vals.length > 1 && vals[vals.length - 1] === ALL) form.setFieldsValue({ sections: [ALL] });
                else if (vals.length > 1 && vals.includes(ALL)) form.setFieldsValue({ sections: vals.filter((v) => v !== ALL) });
              }}
            />
          </Form.Item>
          <Form.Item
            name="accessUntil"
            label="Access until"
            extra="Required. Access stops at the end of this day without anyone acting; it can be extended here."
            rules={[{ required: true, message: 'An end date is required' }]}
          >
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d < dayjs().startOf('day')} />
          </Form.Item>
          {mode === 'give' && (
            <>
              <Paragraph strong style={{ marginBottom: 4 }}>Both confirmations are required.</Paragraph>
              <Form.Item
                name="confidentiality"
                valuePropName="checked"
                rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error('This confirmation is required'))) }]}
                style={{ marginBottom: 8 }}
              >
                <Checkbox>
                  {personName} is bound by a confidentiality undertaking to Taranis Capital that covers this
                  company&apos;s information.
                </Checkbox>
              </Form.Item>
              <Form.Item
                name="ndaPermits"
                valuePropName="checked"
                rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error('This confirmation is required'))) }]}
              >
                <Checkbox>
                  {company.legalName}&apos;s non-disclosure agreement with Taranis Capital permits disclosure to our
                  advisers under confidence.
                </Checkbox>
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <Drawer
        title={`Downloads by ${historyGrant?.displayName || ''}`}
        open={!!historyGrant}
        onClose={() => setHistoryGrant(null)}
        width={640}
      >
        <Table
          rowKey={(r, i) => `${r.fileId}-${i}`}
          dataSource={history}
          pagination={false}
          size="small"
          locale={{ emptyText: 'Nothing opened yet.' }}
          columns={[
            { title: 'When', dataIndex: 'at', width: 190, render: formatUtc },
            { title: 'File', dataIndex: 'filename' },
            { title: 'As', dataIndex: 'accessLevel', width: 100, render: (l) => l || <Text type="secondary">–</Text> },
          ]}
        />
      </Drawer>
    </Space>
  );
}
