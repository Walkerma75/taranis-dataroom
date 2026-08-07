import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Tag, Select, Modal, Form, Input, message, Alert,
  Tooltip,
} from 'antd';
import { DownloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, apiFetch } from '../../api/client.js';
import {
  UNSCANNED_WARNING, UNSCANNED_WARNING_DETAIL, isUnscanned,
  scanLabel, scanColour, scanBackendHint,
  FILE_STATUS_OPTIONS, noteHintFor, noteRequiredFor, NOTE_REQUIRED_MESSAGE,
  formatBytes, formatUtc,
} from '../company/irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

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

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/review-queue${fundId ? `?fundId=${fundId}` : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setRows(body);
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [fundId]);
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
          Documents companies have submitted that nobody has looked at yet, oldest first.
        </Paragraph>
      </div>

      <Alert
        type="info"
        showIcon
        message="Submissions do not send an email yet"
        description="Email notifications arrive in a later release. Until then this queue is the
          only place a new submission shows up, so it is worth checking daily."
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
          <Select
            allowClear
            placeholder="All funds"
            style={{ width: 220 }}
            value={fundId}
            onChange={setFundId}
            options={funds.map((f) => ({ value: f.id, label: f.name }))}
          />
        )}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          locale={{ emptyText: 'Nothing is waiting to be reviewed.' }}
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
