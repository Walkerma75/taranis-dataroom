import { useEffect, useRef, useState } from 'react';
import {
  Typography, Card, Tag, Space, Button, Input, Upload, List, Alert, Spin, message,
  Popconfirm, Divider, Radio, DatePicker, Select, Dropdown,
} from 'antd';
import {
  UploadOutlined, ArrowLeftOutlined, DeleteOutlined, SwapOutlined, EditOutlined, DownOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { api, apiFetch } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  STATE_LABELS, STATE_COLOURS, PRIORITY_LABELS, PRIORITY_COLOURS,
  ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, formatBytes, formatUtc, fileNoteHeading,
  STATEMENT_REASON_OPTIONS, STATEMENT_CARD_TITLE, STATEMENT_CARD_HELP,
  STATEMENT_EXPLANATION_HELP, STATEMENT_ADDED_MESSAGE,
  STATEMENT_EXPLANATION_MIN, STATEMENT_EXPLANATION_MAX,
  isResponse, fileStatusLabel, expectedByText,
} from './irlDisplay.js';
import { NoDocumentTag, ResponseMeta } from './ResponseParts.jsx';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const itemHref = (id) => `/company/items/${id}`;

/** A response that still stands: staged, or submitted and not overtaken. */
const isCurrentResponse = (f) => isResponse(f) && f.status !== 'superseded';

const EMPTY_RESPONSE = { reason: null, explanation: '', expectedDate: null, relatedItemId: null };

/**
 * One checklist item: what is being asked for, what has been sent, and the
 * upload box.
 *
 * The upload button stays disabled until a description has been typed. A
 * description is mandatory server-side and at the column level, so enabling the
 * button first would just produce a rejected request; more importantly the
 * description is what appears on the receipt, so it is worth insisting on it at
 * the moment the file is chosen.
 *
 * "CANNOT PROVIDE THIS DOCUMENT?" (HANDOVER-CW026). A second, separate action
 * for when there is no document to give. The upload card is untouched and still
 * insists on a file (Mark's decision D1): a company that means "we do not have
 * this" says so formally here, with a reason and an explanation, instead of
 * uploading a blank PDF to carry the answer. A response is staged, submitted by
 * the Company Administrator and receipted exactly like a file (D2), and there is
 * at most one current response per item, so the button disappears while one
 * stands and "Replace this response" takes its place on that row.
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
  const [downloadingForm, setDownloadingForm] = useState(null);

  /** Download a standard Taranis form linked to this item (CW027 §3.2). */
  const downloadForm = async (f) => {
    setDownloadingForm(f.id);
    try {
      const res = await apiFetch(`/company/forms/${f.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'This form could not be downloaded.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(err.message);
    }
    setDownloadingForm(null);
  };
  // The file being replaced, not just its id: the upload card names it, and a
  // replacement whose target is invisible is the defect this page had.
  const [replacing, setReplacing] = useState(null);

  // The response card: null when closed, otherwise { mode, file } where mode is
  // 'new', 'replace' (a submitted file or response is being answered with a
  // response) or 'edit' (a staged response).
  const [responseMode, setResponseMode] = useState(null);
  const [response, setResponse] = useState(EMPTY_RESPONSE);
  const [savingResponse, setSavingResponse] = useState(false);
  // This company's other visible items, for "provided under another item".
  const [otherItems, setOtherItems] = useState(null);

  // A wrapper div rather than a ref on the Card. antd's Card does not forward a
  // DOM ref, so scrollIntoView on it silently does nothing.
  const uploadCardRef = useRef(null);
  const responseCardRef = useRef(null);

  /**
   * Put the page into replacement mode and take the user to the upload card.
   *
   * The scroll is the whole fix for the reported defect. Both "Replace" and
   * "Upload a newer version" sit at the bottom of a long file list and their
   * only effect was to change the title of a card off the top of the screen, so
   * the link read as dead and the company worked around it by uploading the
   * correction as a separate document, which is what left the old version
   * flagged for ever (HANDOVER-CW010 §2).
   */
  const startReplacing = (f) => {
    setResponseMode(null);
    setReplacing(f);
    // After the state has painted, so the card is in replacement mode when the
    // scroll lands on it.
    requestAnimationFrame(() => {
      uploadCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /** Open the response card, for a new response, a replacement or an edit. */
  const openResponse = (mode, target = null) => {
    setReplacing(null);
    setResponseMode({ mode, file: target });
    setResponse(mode === 'edit' && target
      ? {
        reason: target.statementReason,
        explanation: target.description || '',
        expectedDate: target.expectedDate ? dayjs(target.expectedDate) : null,
        relatedItemId: target.relatedItemId || null,
      }
      : EMPTY_RESPONSE);
    requestAnimationFrame(() => {
      responseCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const closeResponse = () => {
    setResponseMode(null);
    setResponse(EMPTY_RESPONSE);
  };

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

  // The item picker for "provided under another item", fetched the first time
  // it is needed. The workspace lists only items this company can see.
  useEffect(() => {
    if (response.reason !== 'provided_elsewhere' || otherItems) return;
    api.get('/company/workspace')
      .then((res) => res.json())
      .then((body) => setOtherItems(body.items || []))
      .catch(() => setOtherItems([]));
  }, [response.reason]);

  const submitUpload = async () => {
    if (!file || !description.trim()) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('description', description.trim());
      if (!replacing) form.append('irlItemId', itemId);

      const path = replacing
        ? `/company/files/${replacing.id}/replace`
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

  const explanationLength = response.explanation.trim().length;
  const responseReady = !!response.reason
    && explanationLength >= STATEMENT_EXPLANATION_MIN
    && (response.reason !== 'not_yet_available' || !!response.expectedDate)
    && (response.reason !== 'provided_elsewhere' || !!response.relatedItemId);

  const saveResponse = async () => {
    if (!responseReady) return;
    setSavingResponse(true);
    try {
      const body = {
        reason: response.reason,
        explanation: response.explanation.trim(),
        ...(response.reason === 'not_yet_available'
          ? { expectedDate: response.expectedDate.format('YYYY-MM-DD') } : {}),
        ...(response.reason === 'provided_elsewhere'
          ? { relatedItemId: response.relatedItemId } : {}),
      };

      const res = responseMode.mode === 'edit'
        ? await api.patch(`/company/statements/${responseMode.file.id}`, body)
        : await api.post('/company/statements', {
          ...body,
          ...(responseMode.mode === 'replace'
            ? { replacesFileId: responseMode.file.id }
            : { irlItemId: itemId }),
        });
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error);

      message.success(responseMode.mode === 'edit'
        ? 'Response updated. It is not submitted yet.'
        : STATEMENT_ADDED_MESSAGE);
      closeResponse();
      load();
    } catch (err) {
      message.error(err.message);
    }
    setSavingResponse(false);
  };

  const removeStaged = async (fileId) => {
    try {
      const res = await api.delete(`/company/files/${fileId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      message.success('Removed');
      load();
    } catch (err) {
      message.error(err.message);
    }
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (error) return <Alert message={error} type="error" showIcon />;

  const { item, files, expectedBy, forms = [] } = data;
  const staged = files.filter((f) => f.uploadState === 'staged');
  const submitted = files.filter((f) => f.uploadState === 'submitted');
  const currentResponse = files.find(isCurrentResponse);

  /** "Replace" on a file: with a newer file, or with a response (CW026 §3.2). */
  const replaceMenu = (f, label) => (
    <Dropdown
      key="replace"
      trigger={['click']}
      menu={{
        items: [
          { key: 'file', label: 'Replace with a file' },
          // Only one current response per item, so this is offered only while
          // there is none; with one standing, that row's Replace this response
          // is the way to change the answer.
          ...(currentResponse ? [] : [{ key: 'response', label: 'Replace with a response' }]),
        ],
        onClick: ({ key }) => (key === 'file' ? startReplacing(f) : openResponse('replace', f)),
      }}
    >
      <Button type="link" icon={<SwapOutlined />}>
        {label} <DownOutlined />
      </Button>
    </Dropdown>
  );

  const detailLine = (f, verb, when) => (isResponse(f)
    ? `${verb} ${formatUtc(when)}`
    : `${formatBytes(f.sizeBytes)}, ${verb} ${formatUtc(when)}`);

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
          {expectedBy && <Text strong>{expectedByText(expectedBy)}</Text>}
          {item.note_for_company && (
            <Alert type="info" showIcon message="Note from Taranis" description={item.note_for_company} />
          )}
        </Space>
      </Card>

      {forms.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="Taranis form for this item"
          description={(
            <Space direction="vertical" size="small">
              <Text>Download the form, complete it, and upload the completed form here.</Text>
              <Space wrap>
                {forms.map((f) => (
                  <Button
                    key={f.id}
                    icon={<DownloadOutlined />}
                    loading={downloadingForm === f.id}
                    onClick={() => downloadForm(f)}
                  >
                    {f.title}
                  </Button>
                ))}
              </Space>
            </Space>
          )}
        />
      )}

      {canUpload && (
        <div ref={uploadCardRef}>
        <Card title={replacing ? 'Upload a replacement' : 'Add a document'}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {replacing && (
              <Alert
                type="info"
                showIcon
                message={`Replacing ${replacing.filename}`}
                description={isResponse(replacing)
                  ? 'The document you upload here becomes the current answer to this request. '
                    + 'Your response is kept on the record with everything already said about it, '
                    + 'and stops counting towards this request once you submit the document.'
                  : 'The version you upload here becomes the current one. '
                    + `${replacing.filename} is kept on the record with everything already said `
                    + 'about it, and stops counting towards this request once you submit the '
                    + 'replacement.'}
              />
            )}
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
        </div>
      )}

      {/*
        The separate action (CW026 §3.1). Hidden while the item already has a
        current response, and while the response card is open.
      */}
      {canUpload && !currentResponse && !responseMode && (
        <div>
          <Button onClick={() => openResponse('new')}>Cannot provide this document?</Button>
        </div>
      )}

      {canUpload && responseMode && (
        <div ref={responseCardRef}>
        <Card title={responseMode.mode === 'edit' ? 'Edit this response' : STATEMENT_CARD_TITLE}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>{STATEMENT_CARD_HELP}</Paragraph>

            {responseMode.mode === 'replace' && (
              <Alert
                type="info"
                showIcon
                message={`Replacing ${responseMode.file.filename}`}
                description={responseMode.file.uploadState === 'staged'
                  // Never sent, so there is no record to keep: the server
                  // removes it and the response takes its place.
                  ? `${responseMode.file.filename} has not been submitted, so it is removed and `
                    + 'your response takes its place.'
                  : 'Your response becomes the current answer to this request. '
                    + `${responseMode.file.filename} is kept on the record with everything already `
                    + 'said about it, and stops counting towards this request once you submit the '
                    + 'response.'}
              />
            )}

            <div>
              <Text strong>Reason</Text>
              <Radio.Group
                value={response.reason}
                onChange={(e) => setResponse({ ...response, reason: e.target.value })}
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
              >
                {STATEMENT_REASON_OPTIONS.map((o) => (
                  <Radio key={o.value} value={o.value}>{o.label}</Radio>
                ))}
              </Radio.Group>
            </div>

            {response.reason === 'not_yet_available' && (
              <div>
                <Text strong>Expected date</Text>
                <div style={{ marginTop: 8 }}>
                  <DatePicker
                    format="D MMMM YYYY"
                    value={response.expectedDate}
                    onChange={(value) => setResponse({ ...response, expectedDate: value })}
                    disabledDate={(d) => !!d && d.isBefore(dayjs().startOf('day'))}
                  />
                </div>
              </div>
            )}

            {response.reason === 'provided_elsewhere' && (
              <div>
                <Text strong>Item reference</Text>
                <Select
                  showSearch
                  optionFilterProp="label"
                  loading={!otherItems}
                  style={{ width: '100%', marginTop: 8 }}
                  placeholder="Choose the item you provided it under"
                  value={response.relatedItemId}
                  onChange={(value) => setResponse({ ...response, relatedItemId: value })}
                  options={(otherItems || [])
                    .filter((i) => i.id !== item.id)
                    .map((i) => ({ value: i.id, label: `${i.ref} ${i.description}` }))}
                />
              </div>
            )}

            <div>
              <Text strong>Explanation</Text>
              <Paragraph type="secondary" style={{ marginBottom: 8 }}>{STATEMENT_EXPLANATION_HELP}</Paragraph>
              <TextArea
                rows={3}
                value={response.explanation}
                onChange={(e) => setResponse({ ...response, explanation: e.target.value })}
                maxLength={STATEMENT_EXPLANATION_MAX}
                showCount
              />
              {explanationLength > 0 && explanationLength < STATEMENT_EXPLANATION_MIN && (
                <Text type="secondary">Please write at least {STATEMENT_EXPLANATION_MIN} characters.</Text>
              )}
            </div>

            <Space>
              <Button type="primary" loading={savingResponse} disabled={!responseReady} onClick={saveResponse}>
                {responseMode.mode === 'edit' ? 'Save changes' : 'Add to submission'}
              </Button>
              <Button onClick={closeResponse}>Cancel</Button>
            </Space>
          </Space>
        </Card>
        </div>
      )}

      {staged.length > 0 && (
        <Card title="Ready to submit, not yet sent">
          <List
            dataSource={staged}
            renderItem={(f) => (
              <List.Item
                actions={canUpload ? [
                  isResponse(f)
                    ? (
                      <Button key="edit" type="link" icon={<EditOutlined />} onClick={() => openResponse('edit', f)}>
                        Edit
                      </Button>
                    )
                    : replaceMenu(f, 'Replace'),
                  <Popconfirm
                    key="remove"
                    title={isResponse(f) ? 'Remove this response?' : 'Remove this file?'}
                    onConfirm={() => removeStaged(f.id)}
                    okText="Remove"
                    cancelText="Keep"
                  >
                    <Button type="link" danger icon={<DeleteOutlined />}>Remove</Button>
                  </Popconfirm>,
                ] : []}
              >
                <List.Item.Meta
                  title={(
                    <Space wrap>
                      <Text>{f.filename}</Text>
                      {isResponse(f) && <NoDocumentTag />}
                    </Space>
                  )}
                  description={(
                    <Space direction="vertical" size={0}>
                      <Text>{f.description}</Text>
                      <ResponseMeta file={f} itemHref={itemHref} />
                      <Text type="secondary">
                        {detailLine(f, 'added', f.uploadedAt)} by {f.uploadedBy}
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
                      {isResponse(f) && <NoDocumentTag />}
                      {f.status && (
                        <Tag color={STATE_COLOURS[f.status]} style={{ color: '#fff', borderColor: 'transparent' }}>
                          {fileStatusLabel(f.status, f)}
                        </Tag>
                      )}
                      {f.version > 1 && <Tag>Version {f.version}</Tag>}
                    </Space>
                  )}
                  description={(
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text>{f.description}</Text>
                      <ResponseMeta file={f} itemHref={itemHref} />
                      <Text type="secondary">
                        {detailLine(f, 'submitted', f.submittedAt)}
                        {f.receiptRef ? `, receipt ${f.receiptRef}` : ''}
                      </Text>
                      {f.statusNote && (
                        <Alert
                          type={f.status === 'attention_needed' ? 'warning' : 'info'}
                          showIcon
                          message={fileNoteHeading(f.status)}
                          description={f.statusNote}
                        />
                      )}
                    </Space>
                  )}
                />
                {/*
                  A version that has already been replaced is not the one to
                  replace again: the chain runs from the current version, and
                  the server refuses it too. A response can be replaced by
                  another response or by the document itself; a file by a newer
                  file or by a response (CW026 §3.2).
                */}
                {canUpload && f.status !== 'superseded' && (isResponse(f) ? (
                  <Space direction="vertical" size={0}>
                    <Button type="link" icon={<EditOutlined />} onClick={() => openResponse('replace', f)}>
                      Replace this response
                    </Button>
                    <Button type="link" icon={<SwapOutlined />} onClick={() => startReplacing(f)}>
                      Upload a newer version
                    </Button>
                  </Space>
                ) : replaceMenu(f, 'Upload a newer version'))}
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}
