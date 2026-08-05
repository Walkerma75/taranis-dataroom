import { useEffect, useState } from 'react';
import {
  Typography, Card, Tabs, Table, Button, Space, Tag, Alert, Spin, message, Descriptions,
  DatePicker, Input, Form, Modal, Select, Checkbox, Progress, Popconfirm, Tooltip,
} from 'antd';
import {
  ArrowLeftOutlined, UserAddOutlined, CopyOutlined, WarningOutlined, DownloadOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { api, apiFetch } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  STATE_LABELS, STATE_COLOURS, PRIORITY_LABELS, PRIORITY_COLOURS,
  COMPANY_ROLE_LABELS, COMPANY_STATUS_LABELS, formatBytes, formatUtc,
} from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * One company, Taranis side.
 *
 * The Settings tab is where the two activation gates are recorded, and the
 * Activate button stays disabled until both are. The refusal is also enforced
 * server-side, so this is a courtesy rather than the control.
 */
export default function CompanyDetailPage() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [company, setCompany] = useState(null);
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState(null);
  const [statusFile, setStatusFile] = useState(null);
  const [inviteForm] = Form.useForm();
  const [statusForm] = Form.useForm();

  const canWrite = isAdmin || company?.accessLevel === 'reviewer';

  const load = async () => {
    setLoading(true);
    try {
      const [c, i, f, u] = await Promise.all([
        api.get(`/companies/${companyId}`),
        api.get(`/companies/${companyId}/irl-items`),
        api.get(`/companies/${companyId}/files`),
        api.get(`/companies/${companyId}/users`),
      ]);
      const body = await c.json();
      if (!c.ok) throw new Error(body.error);
      setCompany(body);
      setItems(await i.json());
      setFiles(await f.json());
      setMembers(await u.json());
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [companyId]);

  const patch = async (payload, successMessage) => {
    try {
      const res = await api.patch(`/companies/${companyId}`, payload);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success(successMessage);
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  const post = async (path, body, successMessage) => {
    try {
      const res = await api.post(`/companies/${companyId}${path}`, body || {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(successMessage || data.message);
      load();
      return data;
    } catch (err) {
      message.error(err.message);
      return null;
    }
  };

  const invite = async (values) => {
    const data = await post('/users', values, null);
    if (data) {
      setInviteLink(`${window.location.origin}${data.inviteUrl}`);
      inviteForm.resetFields();
      setInviteOpen(false);
    }
  };

  const setFileStatus = async (values) => {
    try {
      const res = await api.patch(`/company-files/${statusFile.id}/status`, values);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('Status updated');
      setStatusFile(null);
      statusForm.resetFields();
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  const download = async (format) => {
    try {
      const res = await apiFetch(`/companies/${companyId}/export?format=${format}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${company.legalName} ${format === 'gaps' ? 'GAPS' : 'PRE-FILLED'}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
  };

  if (loading || !company) {
    return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  }

  // ---------------------------------------------------------------- Checklist
  const checklistTab = (
    <Table
      rowKey="id"
      dataSource={items}
      pagination={false}
      size="small"
      columns={[
        { title: 'Ref', dataIndex: 'ref', width: 80, render: (r) => <Text style={{ fontFamily: 'monospace' }}>{r}</Text> },
        { title: 'Section', dataIndex: 'section', width: 220 },
        { title: 'Information requested', dataIndex: 'description' },
        {
          title: 'Priority',
          dataIndex: 'priority',
          width: 110,
          render: (p) => (
            <Tag color={PRIORITY_COLOURS[p]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {PRIORITY_LABELS[p]}
            </Tag>
          ),
        },
        {
          title: 'State',
          dataIndex: 'state',
          width: 160,
          render: (state, row) => (canWrite ? (
            <Select
              size="small"
              value={state}
              style={{ width: 150 }}
              onChange={async (value) => {
                const res = await api.patch(`/companies/${companyId}/irl-items/${row.id}`, { state: value });
                if (res.ok) { message.success('Updated'); load(); }
              }}
              options={Object.entries(STATE_LABELS).map(([value, label]) => ({ value, label }))}
            />
          ) : (
            <Tag color={STATE_COLOURS[state]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {STATE_LABELS[state]}
            </Tag>
          )),
        },
        {
          title: 'Note for company',
          dataIndex: 'note_for_company',
          width: 260,
          render: (note, row) => (canWrite ? (
            <Input.TextArea
              defaultValue={note || ''}
              size="small"
              autoSize
              placeholder="Visible to the company"
              onBlur={async (e) => {
                if ((e.target.value || '') === (note || '')) return;
                const res = await api.patch(`/companies/${companyId}/irl-items/${row.id}`, {
                  noteForCompany: e.target.value,
                });
                if (res.ok) message.success('Note saved');
              }}
            />
          ) : note),
        },
        {
          title: 'Internal note',
          dataIndex: 'internal_note',
          width: 260,
          render: (note, row) => (canWrite ? (
            <Input.TextArea
              defaultValue={note || ''}
              size="small"
              autoSize
              placeholder="Never shown to the company"
              onBlur={async (e) => {
                if ((e.target.value || '') === (note || '')) return;
                const res = await api.patch(`/companies/${companyId}/irl-items/${row.id}`, {
                  internalNote: e.target.value,
                });
                if (res.ok) message.success('Internal note saved');
              }}
            />
          ) : note),
        },
      ]}
    />
  );

  // -------------------------------------------------------------------- Files
  const filesTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {files.some((f) => f.scanState !== 'clean') && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="Submitted files cannot be downloaded yet"
          description="No virus scanner is configured on this deployment, so every company upload
            stays quarantined. This is a known gap and is recorded as a go-live blocker for real
            company uploads."
        />
      )}
      <Table
        rowKey="id"
        dataSource={files}
        pagination={false}
        size="small"
        columns={[
          { title: 'Ref', dataIndex: 'itemRef', width: 80, render: (r) => (r ? <Text style={{ fontFamily: 'monospace' }}>{r}</Text> : <Tag>Extra</Tag>) },
          { title: 'File', dataIndex: 'filename' },
          { title: 'Description', dataIndex: 'description' },
          { title: 'Size', dataIndex: 'sizeBytes', width: 90, render: formatBytes },
          { title: 'Receipt', dataIndex: 'receiptRef', width: 170, render: (r) => <Text style={{ fontFamily: 'monospace' }}>{r}</Text> },
          { title: 'Submitted', dataIndex: 'submittedAt', width: 170, render: formatUtc },
          {
            title: 'Scan',
            dataIndex: 'scanState',
            width: 100,
            render: (s, row) => (
              <Tooltip title={row.scanBackend === 'stub' ? 'Not scanned: no scanner is configured' : row.scanBackend}>
                <Tag color={s === 'clean' ? '#3A5247' : s === 'infected' ? '#B54A32' : '#8C8C8C'}
                     style={{ color: '#fff', borderColor: 'transparent' }}>
                  {s === 'clean' ? 'Clean' : s === 'infected' ? 'Quarantined' : 'Not scanned'}
                </Tag>
              </Tooltip>
            ),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 160,
            render: (status) => (
              <Tag color={STATE_COLOURS[status]} style={{ color: '#fff', borderColor: 'transparent' }}>
                {STATE_LABELS[status]}
              </Tag>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 110,
            render: (_, row) => (canWrite ? (
              <Button size="small" onClick={() => { setStatusFile(row); statusForm.setFieldsValue({ status: row.status }); }}>
                Set status
              </Button>
            ) : null),
          },
        ]}
      />
    </Space>
  );

  // -------------------------------------------------------------------- Users
  const usersTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {members.some((m) => m.domainMatched === false && !m.approved) && (
        <Alert
          type="warning"
          showIcon
          message="A nomination is on an unrecognised email domain"
          description="Check who this person is before approving the nomination."
        />
      )}
      <Table
        rowKey="membershipId"
        dataSource={members}
        pagination={false}
        size="small"
        columns={[
          {
            title: 'Name',
            dataIndex: 'displayName',
            render: (name, row) => (
              <Space>
                <Text>{name}</Text>
                {row.isPrimary && <Tag color="#2C3E35">Primary contact</Tag>}
                {row.domainMatched === false && <Tag color="#C9A84C">Off-domain</Tag>}
              </Space>
            ),
          },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Role', dataIndex: 'companyRole', render: (r) => COMPANY_ROLE_LABELS[r] || r },
          {
            title: 'Status',
            key: 'status',
            render: (_, row) => {
              if (row.deactivatedAt) return <Tag>Access removed</Tag>;
              if (!row.approved) return <Tag color="#C9A84C">Nomination pending</Tag>;
              if (row.accountStatus === 'invited') return <Tag color="#8C8C8C">Invited</Tag>;
              return <Tag color="#3A5247">Active</Tag>;
            },
          },
          { title: 'Last sign-in', dataIndex: 'lastLogin', render: (d) => (d ? formatUtc(d) : <Text type="secondary">Never</Text>) },
          { title: 'Nominated by', dataIndex: 'nominatedBy', render: (n) => n || <Text type="secondary">Invited directly</Text> },
          {
            title: '',
            key: 'actions',
            width: 200,
            render: (_, row) => (isAdmin ? (
              <Space size={4}>
                {!row.approved && (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      inviteForm.setFieldsValue({
                        email: row.email,
                        displayName: row.displayName,
                        companyRole: row.companyRole,
                      });
                      setInviteOpen(true);
                    }}
                  >
                    Approve and invite
                  </Button>
                )}
                {row.approved && !row.deactivatedAt && (
                  <Popconfirm
                    title="Remove this person's access?"
                    onConfirm={async () => {
                      const res = await api.patch(`/companies/${companyId}/users/${row.userId}`, { active: false });
                      if (res.ok) { message.success('Access removed'); load(); }
                    }}
                    okText="Remove"
                    cancelText="Cancel"
                  >
                    <Button size="small" danger>Remove</Button>
                  </Popconfirm>
                )}
              </Space>
            ) : null),
          },
        ]}
      />
    </Space>
  );

  // ----------------------------------------------------------------- Settings
  const gatesRecorded = company.ndaExecutedAt && company.iemsScreenedAt;

  const settingsTab = (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 720 }}>
      <Card title="Activation gates" size="small">
        <Paragraph type="secondary">
          Both dates must be recorded before this company can be activated. Until then its users
          see nothing, even if they have accepted an invitation.
        </Paragraph>

        <Form layout="vertical">
          <Form.Item label="Executed NDA date">
            <DatePicker
              disabled={!canWrite}
              value={company.ndaExecutedAt ? dayjs(company.ndaExecutedAt) : null}
              onChange={(d) => patch(
                { ndaExecutedAt: d ? d.toISOString() : null },
                d ? 'NDA date recorded' : 'NDA date cleared'
              )}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item label="IEMS screening date">
            <DatePicker
              disabled={!canWrite}
              value={company.iemsScreenedAt ? dayjs(company.iemsScreenedAt) : null}
              onChange={(d) => patch(
                { iemsScreenedAt: d ? d.toISOString() : null },
                d ? 'IEMS screening date recorded' : 'IEMS screening date cleared'
              )}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item label="IEMS reference">
            <Input
              disabled={!canWrite}
              defaultValue={company.iemsReference || ''}
              placeholder="IEMS case reference"
              onBlur={(e) => {
                if ((e.target.value || '') !== (company.iemsReference || '')) {
                  patch({ iemsReference: e.target.value }, 'IEMS reference saved');
                }
              }}
            />
          </Form.Item>

          <Form.Item>
            <Checkbox
              disabled={!canWrite}
              checked={!!company.ndaCheckConfirmedAt}
              onChange={(e) => patch(
                { ndaCheckConfirmed: e.target.checked },
                e.target.checked ? 'NDA check recorded' : 'NDA check cleared'
              )}
            >
              NDA three-point check completed: service-provider clause, no localisation
              restriction, purpose covers evaluation
            </Checkbox>
            {company.ndaCheckConfirmedAt && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Recorded {formatUtc(company.ndaCheckConfirmedAt)}
                </Text>
              </div>
            )}
          </Form.Item>
        </Form>

        {!gatesRecorded && (
          <Alert
            type="warning"
            showIcon
            message={company.activationBlockedBecause}
            style={{ marginBottom: 16 }}
          />
        )}

        {isAdmin && (
          <Space wrap>
            {company.status !== 'active' && company.status !== 'offboarded' && (
              <Popconfirm
                title="Activate this company?"
                description="Its checklist will be seeded from the fund template and its users will
                  be able to sign in."
                onConfirm={() => post('/activate', {}, 'Company activated')}
                okText="Activate"
                cancelText="Cancel"
                disabled={!gatesRecorded}
              >
                <Button type="primary" disabled={!gatesRecorded}>Activate</Button>
              </Popconfirm>
            )}
            {company.status === 'active' && (
              <Popconfirm
                title="Suspend this company?"
                description="Its users will be signed out and will not be able to sign in again."
                onConfirm={() => post('/suspend')}
                okText="Suspend"
                cancelText="Cancel"
              >
                <Button danger>Suspend</Button>
              </Popconfirm>
            )}
            {company.status === 'suspended' && (
              <Button onClick={() => post('/reinstate')}>Reinstate</Button>
            )}
            {company.status !== 'offboarded' && (
              <Popconfirm
                title="Offboard this company?"
                description="Access is revoked permanently. Documents and audit history are retained
                  for eight years."
                onConfirm={() => post('/offboard')}
                okText="Offboard"
                cancelText="Cancel"
              >
                <Button danger>Offboard</Button>
              </Popconfirm>
            )}
          </Space>
        )}
      </Card>

      <Card title="Exports" size="small">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={() => download('prefilled')}>PRE-FILLED</Button>
          <Button icon={<DownloadOutlined />} onClick={() => download('gaps')}>GAPS</Button>
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          GAPS is the sheet that can be sent to the company. It never carries an internal note.
        </Paragraph>
      </Card>
    </Space>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/companies')} style={{ paddingLeft: 0 }}>
        Back to the pipeline
      </Button>

      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space wrap align="center">
            <Title level={3} style={{ margin: 0 }}>{company.legalName}</Title>
            <Tag color={company.status === 'active' ? '#3A5247' : '#8C8C8C'}
                 style={{ color: '#fff', borderColor: 'transparent' }}>
              {COMPANY_STATUS_LABELS[company.status]}
            </Tag>
            {company.accessLevel === 'readonly' && <Tag>Read-only access</Tag>}
          </Space>
          <Descriptions column={{ xs: 1, sm: 2, md: 4 }} size="small">
            <Descriptions.Item label="Fund">{company.fundName}</Descriptions.Item>
            <Descriptions.Item label="Jurisdiction">{company.jurisdiction || 'Not recorded'}</Descriptions.Item>
            <Descriptions.Item label="Activated">
              {company.activatedAt ? formatUtc(company.activatedAt) : 'Not activated'}
            </Descriptions.Item>
            <Descriptions.Item label="Progress">
              <Progress
                percent={company.progress.percentComplete}
                size="small"
                strokeColor="#3A5247"
                style={{ width: 140 }}
              />
            </Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Card
        extra={isAdmin && (
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviteOpen(true)}>
            Invite a user
          </Button>
        )}
      >
        <Tabs
          items={[
            { key: 'checklist', label: `Checklist (${items.length})`, children: checklistTab },
            { key: 'files', label: `Files (${files.length})`, children: filesTab },
            { key: 'users', label: `Users (${members.length})`, children: usersTab },
            { key: 'settings', label: 'Settings', children: settingsTab },
          ]}
        />
      </Card>

      <Modal
        title="Invite a company user"
        open={inviteOpen}
        onCancel={() => setInviteOpen(false)}
        onOk={() => inviteForm.submit()}
        okText="Create invitation"
      >
        <Alert
          type="info"
          showIcon
          message="No email is sent"
          description="This creates an invitation link. Send it to the invitee yourself, together
            with the company guide."
          style={{ marginBottom: 16 }}
        />
        <Form form={inviteForm} layout="vertical" onFinish={invite} requiredMark={false}>
          <Form.Item name="displayName" label="Full name" rules={[{ required: true, message: 'Please enter their name' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email address"
            rules={[{ required: true, message: 'Please enter their email address' }, { type: 'email', message: 'Please enter a valid email address' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="companyRole" label="Role" initialValue="company_admin">
            <Select
              options={[
                { value: 'company_admin', label: 'Administrator, can upload and submit formally' },
                { value: 'company_contributor', label: 'Contributor, can upload but not submit' },
                { value: 'company_viewer', label: 'Viewer, can see the checklist only' },
              ]}
            />
          </Form.Item>
          <Form.Item name="isPrimary" valuePropName="checked" initialValue={false}>
            <Checkbox>This person is the Primary Contact</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Invitation link"
        open={!!inviteLink}
        onCancel={() => setInviteLink(null)}
        footer={[<Button key="close" type="primary" onClick={() => setInviteLink(null)}>Done</Button>]}
      >
        <Paragraph>
          Send this link to the invitee. It expires in seven days and can be used once.
        </Paragraph>
        <Paragraph copyable={{ text: inviteLink, icon: <CopyOutlined /> }} code style={{ wordBreak: 'break-all' }}>
          {inviteLink}
        </Paragraph>
      </Modal>

      <Modal
        title={`Set status: ${statusFile?.filename || ''}`}
        open={!!statusFile}
        onCancel={() => setStatusFile(null)}
        onOk={() => statusForm.submit()}
        okText="Save"
      >
        <Form form={statusForm} layout="vertical" onFinish={setFileStatus} requiredMark={false}>
          <Form.Item name="status" label="Status" rules={[{ required: true, message: 'Please choose a status' }]}>
            <Select
              options={[
                { value: 'received', label: 'Received' },
                { value: 'in_review', label: 'In review' },
                { value: 'attention_needed', label: 'Attention needed' },
                { value: 'completed', label: 'Completed' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.status !== next.status}
          >
            {({ getFieldValue }) => (
              <Form.Item
                name="note"
                label="Note"
                extra={getFieldValue('status') === 'attention_needed'
                  ? 'The company sees this note. Say exactly what is wrong and what you need instead.'
                  : 'Optional.'}
                rules={getFieldValue('status') === 'attention_needed'
                  ? [{ required: true, message: 'A note is required when a file needs attention' }]
                  : []}
              >
                <Input.TextArea rows={3} />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
