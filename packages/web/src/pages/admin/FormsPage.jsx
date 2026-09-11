import { useEffect, useState, useCallback } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Alert, Spin, message, Modal, Form, Input,
  Select, Upload, Drawer, Tooltip,
} from 'antd';
import {
  DownloadOutlined, UploadOutlined, HistoryOutlined, EditOutlined, SwapOutlined,
} from '@ant-design/icons';
import { api, apiFetch } from '../../api/client.js';
import {
  ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, formatBytes, formatUtc,
} from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

const ALL_COMPANIES = 'all';

/**
 * Standard DD forms, Taranis side (HANDOVER-CW027 / C027).
 *
 * Publish once, every company can download. Replacing a form makes a new
 * version and withdraws the old one automatically; withdrawing needs a reason;
 * nothing is ever deleted. "Links" tie a form to the checklist item(s) it
 * answers, by fund and ref, so the company also finds it on that item.
 *
 * Admins only: the nav entry, this page and every route behind it.
 */
export default function FormsPage() {
  const [forms, setForms] = useState([]);
  const [funds, setFunds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Publish / replace / edit share one modal; `mode` decides which.
  const [mode, setMode] = useState(null);            // 'publish' | 'replace' | 'edit'
  const [target, setTarget] = useState(null);        // the form being replaced / edited
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [linkFund, setLinkFund] = useState(null);
  const [refs, setRefs] = useState([]);

  const [withdrawTarget, setWithdrawTarget] = useState(null);
  const [withdrawForm] = Form.useForm();

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [formsRes, fundsRes] = await Promise.all([api.get('/forms'), api.get('/funds')]);
      const formsBody = await formsRes.json();
      const fundsBody = await fundsRes.json();
      if (!formsRes.ok) throw new Error(formsBody.error);
      if (!fundsRes.ok) throw new Error(fundsBody.error);
      setForms(formsBody);
      setFunds(fundsBody);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refs for the link picker come from the chosen fund's IRL master.
  useEffect(() => {
    if (!linkFund) { setRefs([]); return; }
    api.get(`/forms/refs?fundId=${encodeURIComponent(linkFund)}`)
      .then((res) => res.json())
      .then((body) => setRefs(Array.isArray(body) ? body : []))
      .catch(() => setRefs([]));
  }, [linkFund]);

  const openPublish = () => {
    setMode('publish');
    setTarget(null);
    setFile(null);
    form.resetFields();
    form.setFieldsValue({ fundId: ALL_COMPANIES, refs: [] });
    setLinkFund(funds[0]?.id || null);
  };

  const openFor = (nextMode, row) => {
    setMode(nextMode);
    setTarget(row);
    setFile(null);
    form.resetFields();
    const fundOfLinks = row.links[0]?.fundId || row.fundId || funds[0]?.id || null;
    form.setFieldsValue({
      title: row.title,
      description: row.description || '',
      fundId: row.fundId || ALL_COMPANIES,
      refs: row.links.map((l) => l.ref),
    });
    setLinkFund(fundOfLinks);
  };

  const close = () => { setMode(null); setTarget(null); setFile(null); };

  const save = async () => {
    const values = await form.validateFields();
    if (mode !== 'edit' && !file) {
      message.error('Choose a file.');
      return;
    }
    const links = (values.refs || []).map((ref) => ({ fundId: linkFund, ref }));
    const fundId = values.fundId === ALL_COMPANIES ? '' : values.fundId;
    setSaving(true);
    try {
      let res;
      if (mode === 'edit') {
        res = await api.patch(`/forms/${target.id}`, {
          title: values.title.trim(),
          description: values.description || '',
          fundId,
          links,
        });
      } else {
        const body = new FormData();
        body.append('file', file);
        body.append('title', values.title.trim());
        body.append('description', values.description || '');
        body.append('fundId', fundId);
        body.append('links', JSON.stringify(links));
        const path = mode === 'replace' ? `/forms/${target.id}/replace` : '/forms';
        res = await apiFetch(path, { method: 'POST', body });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(data.message || 'Saved');
      close();
      load();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    const { reason } = await withdrawForm.validateFields();
    try {
      const res = await api.post(`/forms/${withdrawTarget.id}/withdraw`, { reason: reason.trim() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(data.message);
      setWithdrawTarget(null);
      withdrawForm.resetFields();
      load();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.message);
    }
  };

  const download = async (row) => {
    try {
      const res = await apiFetch(`/forms/${row.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = row.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const res = await api.get('/forms/history');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setHistory(body);
    } catch (err) {
      message.error(err.message);
    }
    setHistoryLoading(false);
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (error) return <Alert message={error} type="error" showIcon />;

  const visibility = (row) => (row.fundId
    ? <Tag>{row.fundName || 'One fund'}</Tag>
    : <Tag color="#3A5247" style={{ color: '#fff', borderColor: 'transparent' }}>All companies</Tag>);

  const linksCell = (row) => (row.links.length === 0
    ? <Text type="secondary">None</Text>
    : (
      <Space size={4} wrap>
        {row.links.map((l) => (
          <Tooltip key={`${l.fundId}-${l.ref}`} title={l.description || l.fundName}>
            <Tag>{l.ref}</Tag>
          </Tooltip>
        ))}
      </Space>
    ));

  const columns = [
    {
      title: 'Form',
      dataIndex: 'title',
      render: (title, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{title}</Text>
          {row.description && <Text type="secondary">{row.description}</Text>}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.filename}, {formatBytes(row.sizeBytes)}
          </Text>
        </Space>
      ),
    },
    { title: 'Visible to', key: 'visibility', width: 150, render: (_, row) => visibility(row) },
    { title: 'For items', key: 'links', width: 180, render: (_, row) => linksCell(row) },
    {
      title: 'Version',
      key: 'version',
      width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>Version {row.version}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatUtc(row.publishedAt)} by {row.publishedBy}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Downloads',
      dataIndex: 'downloads',
      width: 110,
      render: (n) => <Text>{n ?? 0}</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 330,
      render: (_, row) => (
        <Space size={4} wrap>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => download(row)}>Download</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openFor('edit', row)}>Edit</Button>
          <Button size="small" icon={<SwapOutlined />} onClick={() => openFor('replace', row)}>New version</Button>
          <Button size="small" danger onClick={() => setWithdrawTarget(row)}>Withdraw</Button>
        </Space>
      ),
    },
  ];

  const historyColumns = [
    { title: 'Form', dataIndex: 'title', render: (t, row) => <Text delete={!!row.withdrawnAt}>{t}</Text> },
    { title: 'Version', dataIndex: 'version', width: 90 },
    { title: 'Visible to', key: 'v', width: 140, render: (_, row) => visibility(row) },
    {
      title: 'Published',
      key: 'p',
      width: 210,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text>{formatUtc(row.publishedAt)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>by {row.publishedBy}</Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 's',
      width: 260,
      render: (_, row) => (row.withdrawnAt ? (
        <Space direction="vertical" size={0}>
          <Tag color="#8C8C8C" style={{ color: '#fff', borderColor: 'transparent' }}>Withdrawn</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatUtc(row.withdrawnAt)} by {row.withdrawnBy}
          </Text>
          {row.withdrawnReason && (
            <Text type="secondary" style={{ fontSize: 12 }}>{row.withdrawnReason}</Text>
          )}
        </Space>
      ) : (
        <Tag color="#3A5247" style={{ color: '#fff', borderColor: 'transparent' }}>Current</Tag>
      )),
    },
    { title: 'Downloads', dataIndex: 'downloads', width: 100 },
    {
      title: '',
      key: 'a',
      width: 120,
      render: (_, row) => (
        <Button size="small" icon={<DownloadOutlined />} onClick={() => download(row)}>Download</Button>
      ),
    },
  ];

  const modalTitle = { publish: 'Publish a form', replace: `New version of ${target?.title || ''}`, edit: `Edit ${target?.title || ''}` }[mode];
  const okText = { publish: 'Publish', replace: `Publish version ${(target?.version || 0) + 1}`, edit: 'Save' }[mode];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Forms</Title>
        <Paragraph type="secondary">
          Standard forms companies download, complete and upload against a checklist item. A form is
          published once and every company can see it, or only the companies in one fund. Link it
          to the item it answers and the company also finds it on that item.
        </Paragraph>
      </div>

      <Alert
        type="info"
        showIcon
        message="Companies are not notified"
        description="A published or replaced form appears in every company's portal straight away,
          but no email announces it."
      />

      <Space>
        <Button type="primary" icon={<UploadOutlined />} onClick={openPublish}>Publish a form</Button>
        <Button icon={<HistoryOutlined />} onClick={openHistory}>History</Button>
      </Space>

      <Card>
        <Table
          rowKey="id"
          dataSource={forms}
          columns={columns}
          pagination={false}
          size="small"
          locale={{ emptyText: 'No forms have been published yet.' }}
        />
      </Card>

      <Text type="secondary">
        A new version withdraws the previous one automatically, with the reason recorded. Withdrawing
        hides a form from every company; the record of the publication and of every download is
        kept permanently.
      </Text>

      <Modal
        title={modalTitle}
        open={!!mode}
        onCancel={close}
        onOk={save}
        okText={okText}
        confirmLoading={saving}
        destroyOnClose
      >
        {mode !== 'edit' && (
          <Alert
            type="warning"
            showIcon
            message="This will be visible to every company it is addressed to"
            description="All of their users can download it, including viewers. Check the form
              carries nothing internal before you publish it."
            style={{ marginBottom: 16 }}
          />
        )}
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="title"
            label="Title"
            extra="Companies see this. Name the form as they would."
            rules={[{ required: true, whitespace: true, message: 'Please give the form a title' }]}
          >
            <Input placeholder="For example: Beneficial Owner Declaration" />
          </Form.Item>
          <Form.Item name="description" label="Description" extra="Optional. Also visible to them.">
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="fundId" label="Visible to">
            <Select
              options={[
                { value: ALL_COMPANIES, label: 'All companies' },
                ...funds.map((f) => ({ value: f.id, label: `${f.name} only` })),
              ]}
            />
          </Form.Item>
          <Form.Item label="For checklist items" extra="Optional. The company also finds the form on these items.">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                value={linkFund}
                onChange={(v) => { setLinkFund(v); form.setFieldsValue({ refs: [] }); }}
                options={funds.map((f) => ({ value: f.id, label: `${f.name} checklist` }))}
                placeholder="Which fund's checklist"
              />
              <Form.Item name="refs" noStyle>
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  placeholder="Choose items"
                  options={refs.map((r) => ({ value: r.ref, label: `${r.ref}  ${r.description}` }))}
                />
              </Form.Item>
            </Space>
          </Form.Item>
          {mode !== 'edit' && (
            <Form.Item label="File" required>
              <Upload
                accept={ACCEPTED_UPLOAD_TYPES}
                maxCount={1}
                fileList={file ? [{ uid: '1', name: file.name }] : []}
                beforeUpload={(f) => {
                  if (f.size > MAX_UPLOAD_BYTES) {
                    message.error('Files must be 200 MB or smaller.');
                    return Upload.LIST_IGNORE;
                  }
                  setFile(f);
                  return false;
                }}
                onRemove={() => setFile(null)}
              >
                <Button icon={<UploadOutlined />}>Choose a file</Button>
              </Upload>
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={`Withdraw ${withdrawTarget?.title || ''}`}
        open={!!withdrawTarget}
        onCancel={() => { setWithdrawTarget(null); withdrawForm.resetFields(); }}
        onOk={withdraw}
        okText="Withdraw"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        <Paragraph>
          Every company will stop seeing this form. The record of the publication and of every
          download is kept. To offer it again, publish it again.
        </Paragraph>
        <Form form={withdrawForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="reason"
            label="Reason"
            rules={[{ required: true, whitespace: true, message: 'A reason is required' }]}
          >
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="Form history"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width={1000}
      >
        <Table
          rowKey="id"
          dataSource={history}
          columns={historyColumns}
          loading={historyLoading}
          pagination={false}
          size="small"
        />
      </Drawer>
    </Space>
  );
}
