import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Select, Modal, Form, Input, message, Alert,
  Tooltip, Segmented,
} from 'antd';
import { DownloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, apiFetch } from '../../api/client.js';
import {
  UNSCANNED_WARNING, UNSCANNED_WARNING_DETAIL, isUnscanned,
  scanLabel, scanColour, scanBackendHint,
  FILE_STATUS_OPTIONS, noteHintFor, noteRequiredFor, NOTE_REQUIRED_MESSAGE,
  STATE_LABELS, STATE_COLOURS,
  formatBytes, formatUtc,
} from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * What the queue is showing.
 *
 * 'received' is the default and is what this page has always been. The other
 * two exist because taking a file up used to make it vanish: the Set status
 * button below defaults to In review, and a file in that state appeared on no
 * other screen but its own company's Files tab. So a submission somebody
 * started reading and did not finish aged where nobody could see it, which is
 * the staleness the dashboard was built to catch (HANDOVER-C020 D3).
 *
 * The dashboard's Awaiting Taranis tile links here with status=all, because
 * that tile counts both.
 */
const STATUS_FILTERS = [
  { value: 'received', label: 'To open' },
  { value: 'in_review', label: 'In review' },
  { value: 'all', label: 'All awaiting Taranis' },
];

/**
 * Everything submitted and not yet looked at, oldest first, across companies.
 *
 * Until the Phase 1b email work lands, nothing tells a reviewer that a
 * submission has arrived. This page is the substitute for that notification, so
 * it is the page the deal team is meant to start from.
 */
export default function ReviewQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [funds, setFunds] = useState([]);
  const [fundId, setFundId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFile, setStatusFile] = useState(null);
  const [downloadingFile, setDownloadingFile] = useState(null);
  const [form] = Form.useForm();

  // In the URL rather than in state, so the dashboard tile can link straight to
  // the view it counted and so a reviewer can keep the link.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('status');
  const statusFilter = STATUS_FILTERS.some((f) => f.value === requested) ? requested : 'received';

  const setStatusFilter = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'received') next.delete('status');
    else next.set('status', value);
    setSearchParams(next, { replace: true });
  };

  const load = async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (fundId) query.set('fundId', fundId);
      if (statusFilter !== 'received') query.set('status', statusFilter);
      const suffix = query.toString() ? `?${query}` : '';

      const res = await api.get(`/review-queue${suffix}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setRows(body);
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [fundId, statusFilter]);
  useEffect(() => {
    api.get('/funds').then((r) => r.json()).then(setFunds).catch(() => {});
  }, []);

  const setStatus = async (values) => {
    try {
      const res = await api.patch(`/company-files/${statusFile.id}/status`, values);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('Status updated');
      setStatusFile(null);
      form.resetFields();
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  /**
   * Open a queued file. Same endpoint and same server-published decision as the
   * company Files tab: this is the screen a reviewer takes the status decision
   * on, so it has to be the screen they can read the document from.
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

  const columns = [
    {
      title: 'Company',
      dataIndex: 'companyName',
      render: (name, row) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/admin/companies/${row.companyId}`)}>
          {name}
        </Button>
      ),
    },
    {
      title: 'Ref',
      dataIndex: 'itemRef',
      width: 90,
      render: (r) => (r ? <Text style={{ fontFamily: 'monospace' }}>{r}</Text> : <Tag>Extra</Tag>),
    },
    { title: 'File', dataIndex: 'filename' },
    { title: 'Description', dataIndex: 'description' },
    { title: 'Size', dataIndex: 'sizeBytes', width: 90, render: formatBytes },
    {
      title: 'Receipt',
      dataIndex: 'receiptRef',
      width: 170,
      render: (r) => <Text style={{ fontFamily: 'monospace' }}>{r}</Text>,
    },
    { title: 'Submitted', dataIndex: 'submittedAt', width: 170, render: formatUtc },
    // Only when the view can contain more than one status. With the default
    // filter every row says the same word, and a column that never varies is
    // just narrower rows.
    ...(statusFilter === 'all'
      ? [{
        title: 'Status',
        dataIndex: 'status',
        width: 130,
        render: (s) => (
          <Tag color={STATE_COLOURS[s]} style={{ color: '#fff', borderColor: 'transparent' }}>
            {STATE_LABELS[s] || s}
          </Tag>
        ),
      }]
      : []),
    {
      title: 'Scan',
      dataIndex: 'scanState',
      width: 110,
      // Carried here as well as on the Files tab so the download button being
      // disabled is explicable on the row rather than only in its tooltip.
      render: (s, row) => (
        <Tooltip title={scanBackendHint(row)}>
          <Tag color={scanColour(s)} style={{ color: '#fff', borderColor: 'transparent' }}>
            {scanLabel(s)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 210,
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
          <Button size="small" onClick={() => { setStatusFile(row); form.setFieldsValue({ status: 'in_review' }); }}>
            Set status
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Review queue</Title>
        <Paragraph type="secondary">
          {statusFilter === 'received'
            && 'Documents companies have submitted that nobody has looked at yet, oldest first.'}
          {statusFilter === 'in_review'
            && 'Documents somebody has taken up but not finished with, oldest first.'}
          {statusFilter === 'all'
            && 'Everything companies have submitted that is still waiting on Taranis, oldest first.'}
        </Paragraph>
      </div>

      {/*
        Corrected 2 September 2026. This banner said email notifications had not
        arrived yet, which stopped being true when Phase 1b wired
        'submission-notification' to the admin address in August. Leaving it
        would have told a reviewer to treat this screen as the only signal at
        the same time as the dashboard started emailing them about it.
      */}
      <Alert
        type="info"
        showIcon
        message="A submission emails the admin address, and shows up here"
        description="Every formal submission sends a notice to the admin address and appears in
          this queue. Taking a file up moves it to In review, which is a separate tab above:
          the dashboard counts both, so nothing sits half read without being visible."
      />

      {rows.some(isUnscanned) && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={UNSCANNED_WARNING}
          description={UNSCANNED_WARNING_DETAIL}
        />
      )}

      <Card
        extra={(
          <Space>
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTERS}
            />
            <Select
              allowClear
              placeholder="All funds"
              style={{ width: 220 }}
              value={fundId}
              onChange={setFundId}
              options={funds.map((f) => ({ value: f.id, label: f.name }))}
            />
          </Space>
        )}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          locale={{
            emptyText: statusFilter === 'in_review'
              ? 'Nothing is part way through review.'
              : 'Nothing is waiting to be reviewed.',
          }}
        />
      </Card>

      <Modal
        title={`Set status: ${statusFile?.filename || ''}`}
        open={!!statusFile}
        onCancel={() => setStatusFile(null)}
        onOk={() => form.submit()}
        okText="Save"
      >
        <Form form={form} layout="vertical" onFinish={setStatus} requiredMark={false}>
          <Form.Item name="status" label="Status" rules={[{ required: true, message: 'Please choose a status' }]}>
            <Select options={FILE_STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.status !== next.status}>
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
