import { useEffect, useState } from 'react';
import {
  Typography, Card, Tabs, Table, Button, Space, Tag, Alert, Spin, message, Descriptions,
  DatePicker, Input, Form, Modal, Select, Checkbox, Progress, Popconfirm, Tooltip, Upload,
} from 'antd';
import {
  ArrowLeftOutlined, UserAddOutlined, CopyOutlined, WarningOutlined, DownloadOutlined,
  UploadOutlined, SendOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api, apiFetch } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  STATE_LABELS, STATE_COLOURS, PRIORITY_LABELS, PRIORITY_COLOURS,
  COMPANY_ROLE_LABELS, COMPANY_STATUS_LABELS, ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES,
  OFF_DOMAIN_COLOUR, OFF_DOMAIN_LABEL, OFF_DOMAIN_WARNING, OFF_DOMAIN_WARNING_DETAIL,
  isOffDomain, isPendingNomination, inviteBlockedReason,
  UNSCANNED_WARNING, UNSCANNED_WARNING_DETAIL, isUnscanned,
  scanLabel, scanColour, scanBackendHint,
  FILE_STATUS_OPTIONS, noteHintFor, noteRequiredFor, NOTE_REQUIRED_MESSAGE,
  formatBytes, formatUtc,
} from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/** Tabs that can be linked to directly, for example from the admin Users page. */
const TAB_KEYS = ['checklist', 'files', 'users', 'shared', 'settings'];

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Which tab is open is in the URL, so a link can land on it. An unknown or
  // missing value falls back to the checklist, which is what the page opened on
  // before this existed.
  const requestedTab = searchParams.get('tab');
  const activeTab = TAB_KEYS.includes(requestedTab) ? requestedTab : 'checklist';

  const [company, setCompany] = useState(null);
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [members, setMembers] = useState([]);
  const [shared, setShared] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  // What `GET /companies/:id/users/lookup` says about the address being typed:
  // null while unknown, { exists: false } or the matched account.
  const [existingAccount, setExistingAccount] = useState(null);
  const [statusFile, setStatusFile] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishFile, setPublishFile] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [withdrawDoc, setWithdrawDoc] = useState(null);
  const [downloadingFile, setDownloadingFile] = useState(null);
  const [inviteForm] = Form.useForm();
  const [statusForm] = Form.useForm();
  const [publishForm] = Form.useForm();
  const [withdrawForm] = Form.useForm();

  const canWrite = isAdmin || company?.accessLevel === 'reviewer';

  const load = async () => {
    setLoading(true);
    try {
      const [c, i, f, u, s] = await Promise.all([
        api.get(`/companies/${companyId}`),
        api.get(`/companies/${companyId}/irl-items`),
        api.get(`/companies/${companyId}/files`),
        api.get(`/companies/${companyId}/users`),
        api.get(`/companies/${companyId}/shared-files`),
      ]);
      const body = await c.json();
      if (!c.ok) throw new Error(body.error);
      setCompany(body);
      setItems(await i.json());
      setFiles(await f.json());
      setMembers(await u.json());
      setShared(await s.json());
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
      // Absolute since Phase 1b: the API knows its own public address now
      // (PORTAL_URL), because the invitation email needs a link that works from
      // a mail client. Prefixing the origin here would double it.
      setInviteResult(data);
      inviteForm.resetFields();
      setExistingAccount(null);
      setInviteOpen(false);
    }
  };

  /**
   * Ask whether an address already has an account, so the modal can name the
   * person the invitation will actually go to before it is created.
   *
   * On blur rather than on every keystroke: a half-typed address is not a
   * question worth asking, and this endpoint answers about real addresses.
   * A failure here is silent by design. The lookup is a courtesy; the server
   * makes the same checks again when the invitation is submitted, so a lookup
   * that cannot run must not block an administrator from inviting anyone.
   */
  const lookupEmail = async (event) => {
    const email = (event.target.value || '').trim();
    if (!email || !email.includes('@')) {
      setExistingAccount(null);
      return;
    }
    try {
      const res = await api.get(
        `/companies/${companyId}/users/lookup?email=${encodeURIComponent(email)}`
      );
      const data = await res.json();
      if (!res.ok) return;
      setExistingAccount(data);
      // The account's own name is the one that will be used, so show it rather
      // than leave a field on screen whose value the server is going to ignore.
      if (data.exists && data.displayName) {
        inviteForm.setFieldsValue({ displayName: data.displayName });
      }
    } catch {
      setExistingAccount(null);
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

  /**
   * Publish a document into the company's workspace.
   *
   * The confirmation copy says plainly that this is visible to the company and
   * that nothing notifies them. Both matter: this is the one action on this
   * screen that puts something in front of the counterparty, and nothing tells
   * them it has arrived until somebody says so. Phase 1b did not change that;
   * there is no approved template for a published document.
   */
  const publish = async () => {
    const values = await publishForm.validateFields();
    if (!publishFile) {
      message.error('Choose a file to share.');
      return;
    }
    setPublishing(true);
    try {
      const form = new FormData();
      form.append('file', publishFile);
      form.append('title', values.title.trim());
      if (values.description) form.append('description', values.description.trim());

      const res = await apiFetch(`/companies/${companyId}/shared-files`, {
        method: 'POST', body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);

      message.success(body.message);
      publishForm.resetFields();
      setPublishFile(null);
      setPublishOpen(false);
      load();
    } catch (err) {
      if (err.errorFields) return;   // form validation, already shown inline
      message.error(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const withdrawShared = async (doc, reason) => {
    try {
      const res = await api.post(
        `/companies/${companyId}/shared-files/${doc.id}/withdraw`,
        { reason: reason || null }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success(body.message);
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  const downloadShared = async (doc) => {
    try {
      const res = await apiFetch(`/companies/${companyId}/shared-files/${doc.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
  };

  /**
   * Open a file a company submitted.
   *
   * Whether this is offered at all is the server's decision, carried on the row
   * as `downloadable`. Nothing here re-derives the rule: an unscanned file is
   * downloadable under the stub backend and refused under a real one, and only
   * the API knows which is live (HANDOVER-CW006 §3 item 3).
   */
  const downloadFile = async (file) => {
    setDownloadingFile(file.id);
    try {
      const res = await apiFetch(`/company-files/${file.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'This file could not be downloaded.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
    setDownloadingFile(null);
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

  // Why the invite controls are off, or null when the company is active. The
  // server refuses the same thing; this is so an admin is told the rule rather
  // than shown a button that fails.
  const inviteBlocked = inviteBlockedReason(company.status);

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
      {files.some(isUnscanned) && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={UNSCANNED_WARNING}
          description={UNSCANNED_WARNING_DETAIL}
        />
      )}
      <Table
        rowKey="id"
        dataSource={files}
        pagination={false}
        size="small"
        columns={[
          { title: 'Ref', dataIndex: 'itemRef', width: 80, render: (r) => (r ? <Text style={{ fontFamily: 'monospace' }}>{r}</Text> : <Tag>Extra</Tag>) },
          {
            title: 'File',
            dataIndex: 'filename',
            // A superseded version keeps its own row, so two rows can carry the
            // same filename. The version number is the only thing that tells
            // them apart, and both stay downloadable.
            render: (filename, row) => (
              <Space size={6}>
                <Text>{filename}</Text>
                {row.version > 1 && <Tag>v{row.version}</Tag>}
              </Space>
            ),
          },
          { title: 'Description', dataIndex: 'description' },
          { title: 'Size', dataIndex: 'sizeBytes', width: 90, render: formatBytes },
          { title: 'Receipt', dataIndex: 'receiptRef', width: 170, render: (r) => <Text style={{ fontFamily: 'monospace' }}>{r}</Text> },
          { title: 'Submitted', dataIndex: 'submittedAt', width: 170, render: formatUtc },
          {
            title: 'Scan',
            dataIndex: 'scanState',
            width: 110,
            render: (s, row) => (
              <Tooltip title={scanBackendHint(row)}>
                <Tag color={scanColour(s)} style={{ color: '#fff', borderColor: 'transparent' }}>
                  {scanLabel(s)}
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
            width: 210,
            // Download is NOT gated on canWrite. A readonly reviewer is assigned
            // to read this company's diligence, and reading it means opening the
            // documents; the API agrees, resolving the download at read level.
            render: (_, row) => (
              <Space size={4}>
                <Tooltip title={row.downloadBlockedReason}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!row.downloadable}
                    loading={downloadingFile === row.id}
                    onClick={() => downloadFile(row)}
                  >
                    Download
                  </Button>
                </Tooltip>
                {canWrite && (
                  <Button size="small" onClick={() => { setStatusFile(row); statusForm.setFieldsValue({ status: row.status }); }}>
                    Set status
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );

  // -------------------------------------------------------------------- Users
  const usersTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {members.some((m) => isOffDomain(m) && isPendingNomination(m)) && (
        <Alert
          type="warning"
          showIcon
          message={OFF_DOMAIN_WARNING}
          description={OFF_DOMAIN_WARNING_DETAIL}
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
                {isOffDomain(row) && <Tag color={OFF_DOMAIN_COLOUR}>{OFF_DOMAIN_LABEL}</Tag>}
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
                  <Tooltip title={inviteBlocked}>
                    <Button
                      size="small"
                      type="primary"
                      disabled={!!inviteBlocked}
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
                  </Tooltip>
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

  // -------------------------------------------------------- Shared documents
  //
  // The one place on this screen where something leaves Taranis for the
  // counterparty. Withdrawn rows stay in the table, greyed and labelled, rather
  // than disappearing: if the company downloaded something before it was pulled,
  // the fact that it was ever published has to be visible here and not only in
  // the audit log.
  const liveShared = shared.filter((d) => !d.withdrawnAt);

  const sharedTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* Still true after Phase 1b, and reworded rather than reversed: eight
          events send email, and publishing a shared document is not one of them
          because no approved template covers it. CW012 §3.3 named the two
          invite surfaces; this one is a third and is accurate, so it keeps its
          meaning and loses only the wording the acceptance check searches for. */}
      <Alert
        type="info"
        showIcon
        message="The company is not notified"
        description="Publishing a document makes it visible in the company's portal straight away,
          but no email announces it. Tell the company separately."
      />

      {canWrite && (
        <Button type="primary" icon={<SendOutlined />} onClick={() => setPublishOpen(true)}>
          Share a document
        </Button>
      )}

      <Table
        rowKey="id"
        dataSource={shared}
        pagination={false}
        size="small"
        locale={{ emptyText: 'Nothing has been shared with this company yet.' }}
        rowClassName={(row) => (row.withdrawnAt ? 'taranis-row-withdrawn' : '')}
        columns={[
          {
            title: 'Title',
            dataIndex: 'title',
            render: (title, row) => (
              <Space direction="vertical" size={0}>
                <Text delete={!!row.withdrawnAt} strong={!row.withdrawnAt}>{title}</Text>
                {row.description && <Text type="secondary">{row.description}</Text>}
              </Space>
            ),
          },
          { title: 'File', dataIndex: 'filename' },
          { title: 'Size', dataIndex: 'sizeBytes', width: 90, render: formatBytes },
          {
            title: 'Shared',
            key: 'published',
            width: 230,
            render: (_, row) => (
              <Space direction="vertical" size={0}>
                <Text>{formatUtc(row.publishedAt)}</Text>
                <Text type="secondary">by {row.publishedBy}</Text>
              </Space>
            ),
          },
          {
            title: 'Status',
            key: 'status',
            width: 240,
            render: (_, row) => (row.withdrawnAt ? (
              <Space direction="vertical" size={0}>
                <Tag color="#8C8C8C" style={{ color: '#fff', borderColor: 'transparent' }}>
                  Withdrawn
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {formatUtc(row.withdrawnAt)} by {row.withdrawnBy}
                </Text>
                {row.withdrawnReason && (
                  <Text type="secondary" style={{ fontSize: 12 }}>{row.withdrawnReason}</Text>
                )}
              </Space>
            ) : (
              <Tag color="#3A5247" style={{ color: '#fff', borderColor: 'transparent' }}>
                Visible to the company
              </Tag>
            )),
          },
          {
            title: '',
            key: 'actions',
            width: 210,
            render: (_, row) => (
              <Space size={4}>
                <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadShared(row)}>
                  Download
                </Button>
                {canWrite && !row.withdrawnAt && (
                  <Button size="small" danger onClick={() => setWithdrawDoc(row)}>
                    Withdraw
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Text type="secondary">
        Withdrawing hides a document from the company. The record of the publication and of any
        downloads is kept permanently, so a withdrawn document is still accounted for. To share it
        again, publish it again.
      </Text>
    </Space>
  );

  // ----------------------------------------------------------------- Settings
  const gatesRecorded = company.ndaExecutedAt && company.iemsScreenedAt;

  const settingsTab = (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 720 }}>
      <Card title="Activation gates" size="small">
        <Paragraph type="secondary">
          Both dates must be recorded and the company activated before its users can be invited.
          Activation is what creates the workspace, so an invitation sent earlier would lead to
          an empty screen.
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
          <Tooltip title={inviteBlocked}>
            <Button
              type="primary"
              icon={<UserAddOutlined />}
              disabled={!!inviteBlocked}
              onClick={() => setInviteOpen(true)}
            >
              Invite a user
            </Button>
          </Tooltip>
        )}
      >
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setSearchParams(key === 'checklist' ? {} : { tab: key }, { replace: true })}
          items={[
            { key: 'checklist', label: `Checklist (${items.length})`, children: checklistTab },
            { key: 'files', label: `Files (${files.length})`, children: filesTab },
            { key: 'users', label: `Users (${members.length})`, children: usersTab },
            { key: 'shared', label: `Shared documents (${liveShared.length})`, children: sharedTab },
            { key: 'settings', label: 'Settings', children: settingsTab },
          ]}
        />
      </Card>

      <Modal
        title="Invite a company user"
        open={inviteOpen}
        onCancel={() => { setInviteOpen(false); setExistingAccount(null); }}
        onOk={() => inviteForm.submit()}
        okText="Send invitation"
        okButtonProps={{ disabled: !!existingAccount?.blocked }}
      >
        <Alert
          type="info"
          showIcon
          message="The invitation is emailed automatically"
          description="Creating the invitation sends it to the address below. You will also be
            shown the link, as a fallback you can forward by hand if the message does not
            arrive."
          style={{ marginBottom: 16 }}
        />

        {/* CW012 §3.4. The address is checked before anything is created, so an
            administrator learns that an account already exists here rather than
            from the invitation that goes out under a name they did not expect. */}
        {existingAccount?.exists && (
          <Alert
            type={existingAccount.blocked ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              existingAccount.blocked
                ? 'This address cannot be invited'
                : `This address already belongs to ${existingAccount.displayName}`
            }
            description={
              existingAccount.blocked || (
                existingAccount.membership?.thisCompany
                  ? `${existingAccount.displayName} is already on this company. Continuing will `
                    + 'reissue their invitation and apply the role selected below.'
                  : existingAccount.membership
                    ? `${existingAccount.displayName} currently belongs to `
                      + `${existingAccount.membership.companyName}. Continuing will add that `
                      + 'same person to this company.'
                    : `The existing account will be added to this company. Its name stays as `
                      + `${existingAccount.displayName}, so that is how the invitation will `
                      + 'address them.'
              )
            }
          />
        )}

        <Form form={inviteForm} layout="vertical" onFinish={invite} requiredMark={false}>
          <Form.Item
            name="email"
            label="Email address"
            rules={[{ required: true, message: 'Please enter their email address' }, { type: 'email', message: 'Please enter a valid email address' }]}
          >
            <Input onBlur={lookupEmail} />
          </Form.Item>
          <Form.Item
            name="displayName"
            label="Full name"
            rules={[{ required: true, message: 'Please enter their name' }]}
            extra={existingAccount?.exists
              ? 'Held by the existing account and not changed from here.'
              : undefined}
          >
            <Input disabled={!!existingAccount?.exists} />
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
        title="Invitation sent"
        open={!!inviteResult}
        onCancel={() => setInviteResult(null)}
        footer={[<Button key="close" type="primary" onClick={() => setInviteResult(null)}>Done</Button>]}
      >
        <Paragraph>
          The invitation has been emailed to {inviteResult?.displayName || 'the invitee'}. It
          expires in seven days and can be used once.
        </Paragraph>
        {inviteResult?.existingAccount && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`Added the existing account for ${inviteResult.displayName}`}
            description="No new account was created, and the name on the existing one was left
              as it was."
          />
        )}
        <Paragraph type="secondary">
          The same link is below. You do not need to send it; keep it only in case the message
          is delayed or quarantined and you need to forward it by hand.
        </Paragraph>
        <Paragraph copyable={{ text: inviteResult?.inviteUrl, icon: <CopyOutlined /> }} code style={{ wordBreak: 'break-all' }}>
          {inviteResult?.inviteUrl}
        </Paragraph>
      </Modal>

      <Modal
        title="Share a document with this company"
        open={publishOpen}
        onCancel={() => { setPublishOpen(false); setPublishFile(null); }}
        onOk={publish}
        okText="Share with the company"
        confirmLoading={publishing}
      >
        <Alert
          type="warning"
          showIcon
          message={`This will be visible to everyone at ${company.legalName}`}
          description="All of their users can download it, including viewers. Check the document
            carries nothing internal before you share it."
          style={{ marginBottom: 16 }}
        />
        <Form form={publishForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="title"
            label="Title"
            extra="The company sees this. Name the document as they would."
            rules={[{ required: true, message: 'Please give the document a title' }]}
          >
            <Input placeholder="For example: information request pack" />
          </Form.Item>
          <Form.Item name="description" label="Description" extra="Optional. Also visible to them.">
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
          <Form.Item label="File" required>
            <Upload
              accept={ACCEPTED_UPLOAD_TYPES}
              maxCount={1}
              fileList={publishFile ? [{ uid: '1', name: publishFile.name }] : []}
              beforeUpload={(f) => {
                if (f.size > MAX_UPLOAD_BYTES) {
                  message.error('Files must be 200 MB or smaller.');
                  return Upload.LIST_IGNORE;
                }
                setPublishFile(f);
                return false;
              }}
              onRemove={() => setPublishFile(null)}
            >
              <Button icon={<UploadOutlined />}>Choose a file</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`Withdraw: ${withdrawDoc?.title || ''}`}
        open={!!withdrawDoc}
        onCancel={() => { setWithdrawDoc(null); withdrawForm.resetFields(); }}
        okText="Withdraw"
        okButtonProps={{ danger: true }}
        onOk={async () => {
          const values = await withdrawForm.validateFields();
          await withdrawShared(withdrawDoc, values.reason);
          setWithdrawDoc(null);
          withdrawForm.resetFields();
        }}
      >
        <Paragraph>
          The company will no longer see this document. Nothing is deleted: the publication, the
          withdrawal and any downloads they already made stay on the record.
        </Paragraph>
        <Form form={withdrawForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="reason"
            label="Reason"
            extra="Internal only. The company does not see this."
          >
            <Input.TextArea rows={2} placeholder="For example: superseded by a corrected version" />
          </Form.Item>
        </Form>
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
            <Select options={FILE_STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) => prev.status !== next.status}
          >
            {({ getFieldValue }) => (
              <Form.Item
                name="note"
                label="Note"
                extra={noteHintFor(getFieldValue('status'))}
                rules={noteRequiredFor(getFieldValue('status'))
                  ? [{ required: true, message: NOTE_REQUIRED_MESSAGE }]
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
