import { useEffect, useState } from 'react';
import {
  Typography, Card, Tag, Space, Button, Input, Upload, List, Alert, Spin, message,
  Popconfirm, Divider,
} from 'antd';
import { UploadOutlined, ArrowLeftOutlined, DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { api, apiFetch } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  STATE_LABELS, STATE_COLOURS, PRIORITY_LABELS, PRIORITY_COLOURS,
  ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, formatBytes, formatUtc,
} from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

/**
 * One checklist item: what is being asked for, what has been sent, and the
 * upload box.
 *
 * The upload button stays disabled until a description has been typed. A
 * description is mandatory server-side and at the column level, so enabling the
 * button first would just produce a rejected request; more importantly the
 * description is what appears on the receipt, so it is worth insisting on it at
 * the moment the file is chosen.
 */
export default function ItemDetailPage() {
  const { itemId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canUpload = user?.companyRole === 'company_admin' || user?.companyRole === 'company_contributor';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [replacing, setReplacing] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/company/items/${itemId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [itemId]);

  const submitUpload = async () => {
    if (!file || !description.trim()) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('description', description.trim());
      if (!replacing) form.append('irlItemId', itemId);

      const path = replacing
        ? `/company/files/${replacing}/replace`
        : '/company/files';

      const res = await apiFetch(path, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);

      message.success('File added. It is not submitted yet, go to Ready to submit when you are done.');
      setFile(null);
      setDescription('');
      setReplacing(null);
      load();
    } catch (err) {
      message.error(err.message);
    }
    setUploading(false);
  };

  const removeStaged = async (fileId) => {
    try {
      const res = await api.delete(`/company/files/${fileId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('File removed');
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (error) return <Alert message={error} type="error" showIcon />;

  const { item, files } = data;
  const staged = files.filter((f) => f.uploadState === 'staged');
  const submitted = files.filter((f) => f.uploadState === 'submitted');

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 960 }}>
      <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate('/company')} style={{ paddingLeft: 0 }}>
        Back to information requests
      </Button>

      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Text strong style={{ fontFamily: 'monospace', fontSize: 16 }}>{item.ref}</Text>
            <Tag color={STATE_COLOURS[item.state]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {STATE_LABELS[item.state]}
            </Tag>
            <Tag color={PRIORITY_COLOURS[item.priority]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {PRIORITY_LABELS[item.priority]}
            </Tag>
          </Space>
          <Title level={4} style={{ marginTop: 4 }}>{item.description}</Title>
          <Text type="secondary">{item.section}</Text>
          {item.note_for_company && (
            <Alert type="info" showIcon message="Note from Taranis" description={item.note_for_company} />
          )}
        </Space>
      </Card>

      {canUpload && (
        <Card title={replacing ? 'Upload a replacement' : 'Add a document'}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text strong>Description</Text>
              <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Say what this document is. It appears on your submission receipt, so a clear
                description saves a round trip later.
              </Paragraph>
              <TextArea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="For example: audited accounts for the year ended 31 December 2025"
                maxLength={500}
                showCount
              />
            </div>

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

            <Space>
              <Button
                type="primary"
                loading={uploading}
                disabled={!file || !description.trim()}
                onClick={submitUpload}
              >
                Add to submission
              </Button>
              {replacing && (
                <Button onClick={() => setReplacing(null)}>Cancel replacement</Button>
              )}
            </Space>

            <Text type="secondary">
              Accepted formats: PDF, Word, Excel, PowerPoint, CSV, text, images and zip archives.
              Nothing is sent to Taranis until you submit it formally.
            </Text>
          </Space>
        </Card>
      )}

      {staged.length > 0 && (
        <Card title="Ready to submit, not yet sent">
          <List
            dataSource={staged}
            renderItem={(f) => (
              <List.Item
                actions={canUpload ? [
                  <Button
                    key="replace"
                    type="link"
                    icon={<SwapOutlined />}
                    onClick={() => setReplacing(f.id)}
                  >
                    Replace
                  </Button>,
                  <Popconfirm
                    key="remove"
                    title="Remove this file?"
                    onConfirm={() => removeStaged(f.id)}
                    okText="Remove"
                    cancelText="Keep"
                  >
                    <Button type="link" danger icon={<DeleteOutlined />}>Remove</Button>
                  </Popconfirm>,
                ] : []}
              >
                <List.Item.Meta
                  title={f.filename}
                  description={(
                    <Space direction="vertical" size={0}>
                      <Text>{f.description}</Text>
                      <Text type="secondary">
                        {formatBytes(f.sizeBytes)}, added {formatUtc(f.uploadedAt)} by {f.uploadedBy}
                      </Text>
                    </Space>
                  )}
                />
                {f.version > 1 && <Tag>Version {f.version}</Tag>}
              </List.Item>
            )}
          />
          <Divider style={{ margin: '12px 0' }} />
          <Button type="primary" onClick={() => navigate('/company/staged')}>
            Go to Ready to submit
          </Button>
        </Card>
      )}

      <Card title="Submitted">
        {submitted.length === 0 ? (
          <Text type="secondary">Nothing has been submitted for this request yet.</Text>
        ) : (
          <List
            dataSource={submitted}
            renderItem={(f) => (
              <List.Item>
                <List.Item.Meta
                  title={(
                    <Space wrap>
                      <Text>{f.filename}</Text>
                      {f.status && (
                        <Tag color={STATE_COLOURS[f.status]} style={{ color: '#fff', borderColor: 'transparent' }}>
                          {STATE_LABELS[f.status]}
                        </Tag>
                      )}
                      {f.version > 1 && <Tag>Version {f.version}</Tag>}
                    </Space>
                  )}
                  description={(
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text>{f.description}</Text>
                      <Text type="secondary">
                        {formatBytes(f.sizeBytes)}, submitted {formatUtc(f.submittedAt)}
                        {f.receiptRef ? `, receipt ${f.receiptRef}` : ''}
                      </Text>
                      {f.statusNote && (
                        <Alert
                          type={f.status === 'attention_needed' ? 'warning' : 'info'}
                          showIcon
                          message={f.status === 'attention_needed'
                            ? 'Taranis needs something changed'
                            : 'Note from Taranis'}
                          description={f.statusNote}
                        />
                      )}
                    </Space>
                  )}
                />
                {canUpload && (
                  <Button type="link" icon={<SwapOutlined />} onClick={() => setReplacing(f.id)}>
                    Upload a newer version
                  </Button>
                )}
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}
