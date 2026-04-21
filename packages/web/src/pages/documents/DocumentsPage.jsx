import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Typography, Card, Table, Button, Tag, Space, Select, Modal, Form, Input, Upload, message,
  Tooltip, Divider,
} from 'antd';
import {
  UploadOutlined, DownloadOutlined, EyeOutlined, DeleteOutlined, EditOutlined, FileTextOutlined,
  FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FilePptOutlined, FileImageOutlined,
  SearchOutlined, ExpandOutlined, CompressOutlined,
} from '@ant-design/icons';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasCap } from '../../components/AppLayout.jsx';
import PdfViewer from '../../components/PdfViewer.jsx';
import BulkUploadModal from '../../components/BulkUploadModal.jsx';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { TextArea } = Input;
const API_URL = import.meta.env.VITE_API_URL || '/api';

function fileIcon(mimeType) {
  if (mimeType?.includes('pdf')) return <FilePdfOutlined style={{ color: '#cf1322' }} />;
  if (mimeType?.includes('word') || mimeType?.includes('docx')) return <FileWordOutlined style={{ color: '#1677ff' }} />;
  if (mimeType?.includes('excel') || mimeType?.includes('xlsx') || mimeType?.includes('spreadsheet')) return <FileExcelOutlined style={{ color: '#52c41a' }} />;
  if (mimeType?.includes('presentation') || mimeType?.includes('pptx')) return <FilePptOutlined style={{ color: '#fa8c16' }} />;
  if (mimeType?.includes('image')) return <FileImageOutlined style={{ color: '#722ed1' }} />;
  return <FileTextOutlined />;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Suggest a description based on category name
const categoryDescriptions = {
  'Overview': 'Fund overview and executive summary',
  'Private Placement Memorandum': 'Private placement memorandum detailing fund strategy, terms and risk factors',
  'Legal Documents': 'Legal documentation including partnership agreements, subscription documents and fund terms',
  'Financials': 'Financial statements, reports and performance data',
  'Technical': 'Technical documentation and due diligence materials',
  'Correspondence': 'Investor correspondence and communications',
  'Pitch Deck / Presentation': 'Fund presentation and pitch materials',
};

// Extract a clean title from a filename
function titleFromFilename(filename) {
  if (!filename) return '';
  let name = filename.replace(/\.[^/.]+$/, '');
  name = name.replace(/[_-]/g, ' ');
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_ ]*/, '');
  name = name.replace(/^\d+[-_ ]+/, '');
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());
  return name.trim();
}

export default function DocumentsPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canUpload = hasCap(user, 'canUploadDocuments');
  const canDownload = hasCap(user, 'canDownloadDocuments');

  const [documents, setDocuments] = useState([]);
  const [funds, setFunds] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filterFund, setFilterFund] = useState(searchParams.get('fundId') || null);
  const [filterCategory, setFilterCategory] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [form] = Form.useForm();

  // Viewer modal
  const [viewDoc, setViewDoc] = useState(null);
  const [viewerExpanded, setViewerExpanded] = useState(false);

  // Edit modal
  const [editDoc, setEditDoc] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm] = Form.useForm();

  // Bulk upload modal
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      let url = '/documents';
      const params = [];
      if (filterFund) params.push(`fundId=${filterFund}`);
      if (filterCategory) params.push(`categoryId=${filterCategory}`);
      if (params.length) url += `?${params.join('&')}`;
      const res = await api.get(url);
      if (res.ok) setDocuments(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    Promise.all([
      api.get('/funds').then((r) => r.json()),
      api.get('/funds/categories').then((r) => r.json()),
    ]).then(([f, c]) => {
      setFunds(f);
      setCategories(c);
    });
  }, []);

  useEffect(() => { loadDocuments(); }, [filterFund, filterCategory]);

  // Handle fund filter from URL params (e.g. from Funds page "Documents" button)
  useEffect(() => {
    const urlFundId = searchParams.get('fundId');
    if (urlFundId && urlFundId !== filterFund) {
      setFilterFund(urlFundId);
    }
  }, [searchParams]);

  // Filter documents by search text (client-side)
  const filteredDocuments = useMemo(() => {
    if (!searchText.trim()) return documents;
    const lower = searchText.toLowerCase();
    return documents.filter((d) =>
      d.title?.toLowerCase().includes(lower) ||
      d.description?.toLowerCase().includes(lower) ||
      d.categoryName?.toLowerCase().includes(lower) ||
      d.fundName?.toLowerCase().includes(lower) ||
      d.fileName?.toLowerCase().includes(lower)
    );
  }, [documents, searchText]);

  // When file is selected, auto-fill title from filename
  const handleFileChange = (info) => {
    if (info.file) {
      const suggestedTitle = titleFromFilename(info.file.name);
      const currentTitle = form.getFieldValue('title');
      if (!currentTitle) {
        form.setFieldsValue({ title: suggestedTitle });
      }
    }
  };

  // When category changes, suggest description
  const handleCategoryChange = (categoryId) => {
    const cat = categories.find((c) => c.id === categoryId);
    if (cat) {
      const currentDesc = form.getFieldValue('description');
      if (!currentDesc) {
        const suggestion = categoryDescriptions[cat.name];
        if (suggestion) form.setFieldsValue({ description: suggestion });
      }
    }
  };

  const handleUpload = async (values) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', values.file.file);
      formData.append('fundId', values.fundId);
      formData.append('categoryId', values.categoryId);
      formData.append('title', values.title);
      if (values.description) formData.append('description', values.description);

      const res = await api.post('/documents', formData);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      message.success('Document uploaded');
      form.resetFields();
      setUploadOpen(false);
      loadDocuments();
    } catch (err) {
      message.error(err.message);
    }
    setUploading(false);
  };

  const getDownloadUrl = (doc) => {
    const token = localStorage.getItem('accessToken');
    return `${API_URL}/documents/${doc.id}/download?token=${token}`;
  };

  const getViewUrl = (doc) => {
    const token = localStorage.getItem('accessToken');
    return `${API_URL}/documents/${doc.id}/download?token=${token}&inline=true`;
  };

  const handleDownload = (doc) => {
    window.open(getDownloadUrl(doc), '_blank');
  };

  const handleView = (doc) => {
    setViewerExpanded(false);
    setViewDoc(doc);
  };

  const handleArchive = async (doc) => {
    Modal.confirm({
      title: 'Archive Document',
      content: `Are you sure you want to archive "${doc.title}"?`,
      onOk: async () => {
        try {
          const res = await api.delete(`/documents/${doc.id}`);
          if (!res.ok) throw new Error('Failed');
          message.success('Document archived');
          loadDocuments();
        } catch (err) {
          message.error(err.message);
        }
      },
    });
  };

  const handleEdit = (doc) => {
    setEditDoc(doc);
    editForm.setFieldsValue({
      title: doc.title,
      description: doc.description || '',
      categoryId: doc.categoryId,
    });
  };

  const handleEditSave = async (values) => {
    setEditSaving(true);
    try {
      const res = await api.patch(`/documents/${editDoc.id}`, values);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      message.success('Document updated');
      setEditDoc(null);
      editForm.resetFields();
      loadDocuments();
    } catch (err) {
      message.error(err.message);
    }
    setEditSaving(false);
  };

  // Group documents by fund
  const grouped = {};
  filteredDocuments.forEach((d) => {
    if (!grouped[d.fundName]) grouped[d.fundName] = [];
    grouped[d.fundName].push(d);
  });

  const columns = [
    {
      title: 'Document',
      key: 'title',
      render: (_, doc) => (
        <Space>
          {fileIcon(doc.mimeType)}
          <div>
            <Text strong>{doc.title}</Text>
            {doc.description && <br />}
            {doc.description && <Text type="secondary" style={{ fontSize: 12 }}>{doc.description}</Text>}
          </div>
        </Space>
      ),
    },
    {
      title: 'Category',
      dataIndex: 'categoryName',
      width: 200,
      render: (c) => <Tag>{c}</Tag>,
    },
    {
      title: 'Size',
      dataIndex: 'fileSize',
      width: 100,
      render: formatFileSize,
    },
    {
      title: 'Uploaded',
      key: 'uploaded',
      width: 140,
      render: (_, doc) => (
        <Tooltip title={doc.uploadedBy}>
          {dayjs(doc.createdAt).format('DD MMM YYYY')}
        </Tooltip>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, doc) => (
        <Space>
          <Tooltip title="View">
            <Button icon={<EyeOutlined />} size="small" onClick={() => handleView(doc)} />
          </Tooltip>
          {doc.downloadAllowed && canDownload && (
            <Tooltip title="Download">
              <Button icon={<DownloadOutlined />} size="small" onClick={() => handleDownload(doc)} />
            </Tooltip>
          )}
          {canUpload && (
            <Tooltip title="Edit">
              <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(doc)} />
            </Tooltip>
          )}
          {canUpload && (
            <Tooltip title="Archive">
              <Button icon={<DeleteOutlined />} size="small" danger onClick={() => handleArchive(doc)} />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // Determine if the viewed doc can be previewed in-browser
  const canPreview = viewDoc && (
    viewDoc.mimeType?.includes('pdf') ||
    viewDoc.mimeType?.includes('image')
  );

  const handleFundFilterChange = (v) => {
    setFilterFund(v || null);
    if (v) {
      setSearchParams({ fundId: v });
    } else {
      setSearchParams({});
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>Documents</Title>
        <Space>
          <Input
            placeholder="Search documents..."
            prefix={<SearchOutlined />}
            allowClear
            style={{ width: 220 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            placeholder="Filter by fund"
            allowClear
            style={{ width: 220 }}
            value={filterFund}
            onChange={handleFundFilterChange}
            options={funds.map((f) => ({ value: f.id, label: f.name }))}
          />
          <Select
            placeholder="Filter by category"
            allowClear
            style={{ width: 220 }}
            value={filterCategory}
            onChange={(v) => setFilterCategory(v || null)}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
          {canUpload && (
            <Button icon={<UploadOutlined />} onClick={() => setBulkUploadOpen(true)}>
              Bulk Upload
            </Button>
          )}
          {canUpload && (
            <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
              Upload
            </Button>
          )}
        </Space>
      </div>

      {Object.keys(grouped).length === 0 && !loading ? (
        <Card><Text type="secondary">No documents found.</Text></Card>
      ) : (
        Object.entries(grouped).map(([fundName, docs]) => (
          <Card key={fundName} title={fundName} style={{ marginBottom: 16 }} size="small">
            <Table
              dataSource={docs}
              columns={columns}
              rowKey="id"
              loading={loading}
              pagination={false}
              size="small"
            />
          </Card>
        ))
      )}

      {/* Document viewer modal */}
      <Modal
        title={null}
        open={!!viewDoc}
        onCancel={() => { setViewDoc(null); setViewerExpanded(false); }}
        footer={null}
        width={viewerExpanded ? '100vw' : 900}
        styles={{
          body: { padding: 0 },
          ...(viewerExpanded ? {
            wrapper: { top: 0 },
            content: { borderRadius: 0 },
          } : {}),
        }}
        style={viewerExpanded ? { top: 0, maxWidth: '100vw', paddingBottom: 0, margin: 0 } : {}}
        destroyOnClose
      >
        {viewDoc && (
          <div>
            {/* Header bar with title, expand and download buttons */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 24px',
                borderBottom: '1px solid #f0f0f0',
                background: '#fafafa',
              }}
            >
              <Space>
                {fileIcon(viewDoc.mimeType)}
                <div>
                  <Text strong style={{ fontSize: 16 }}>{viewDoc.title}</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {viewDoc.fundName} — {viewDoc.categoryName} — {formatFileSize(viewDoc.fileSize)}
                  </Text>
                </div>
              </Space>
              <Space>
                {viewDoc.mimeType?.includes('pdf') && (
                  <Tooltip title={viewerExpanded ? 'Compact view' : 'Expand to full screen'}>
                    <Button
                      icon={viewerExpanded ? <CompressOutlined /> : <ExpandOutlined />}
                      onClick={() => setViewerExpanded(!viewerExpanded)}
                    />
                  </Tooltip>
                )}
                {viewDoc.downloadAllowed && canDownload && (
                  <Button
                    type="primary"
                    icon={<DownloadOutlined />}
                    onClick={() => handleDownload(viewDoc)}
                  >
                    Download
                  </Button>
                )}
              </Space>
            </div>

            {/* Document preview area */}
            <div style={{ padding: 0, minHeight: viewerExpanded ? 'calc(100vh - 110px)' : 500 }}>
              {viewDoc.mimeType?.includes('pdf') ? (
                <PdfViewer
                  fileUrl={getViewUrl(viewDoc)}
                  height={viewerExpanded ? window.innerHeight - 110 : 600}
                />
              ) : viewDoc.mimeType?.includes('image') ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <img
                    src={getViewUrl(viewDoc)}
                    alt={viewDoc.title}
                    style={{ maxWidth: '100%', maxHeight: 600 }}
                  />
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 48 }}>
                  {fileIcon(viewDoc.mimeType)}
                  <Title level={4} style={{ marginTop: 16 }}>{viewDoc.fileName}</Title>
                  <Text type="secondary">
                    This file type cannot be previewed in the browser.
                  </Text>
                  {viewDoc.downloadAllowed && canDownload ? (
                    <div style={{ marginTop: 16 }}>
                      <Button
                        type="primary"
                        icon={<DownloadOutlined />}
                        onClick={() => handleDownload(viewDoc)}
                      >
                        Download to View
                      </Button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 16 }}>
                      <Text type="secondary" style={{ fontStyle: 'italic' }}>
                        You do not have permission to download this document. Please contact your fund administrator if you require access.
                      </Text>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Upload modal with auto-fill */}
      <Modal
        title="Upload Document"
        open={uploadOpen}
        onCancel={() => { setUploadOpen(false); form.resetFields(); }}
        footer={null}
        width={500}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item name="fundId" label="Fund" rules={[{ required: true }]}>
            <Select
              placeholder="Select fund"
              options={funds.map((f) => ({ value: f.id, label: f.name }))}
            />
          </Form.Item>
          <Form.Item name="categoryId" label="Category" rules={[{ required: true }]}>
            <Select
              placeholder="Select category"
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
              onChange={handleCategoryChange}
            />
          </Form.Item>
          <Form.Item
            name="file"
            label="File"
            rules={[{ required: true, message: 'Please select a file' }]}
          >
            <Upload beforeUpload={() => false} maxCount={1} onChange={handleFileChange}>
              <Button icon={<UploadOutlined />}>Select File</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input placeholder="Auto-filled from filename — edit if needed" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <TextArea rows={2} placeholder="Suggested based on category — edit if needed" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={uploading} block>
              Upload Document
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit document modal */}
      <Modal
        title="Edit Document"
        open={!!editDoc}
        onCancel={() => { setEditDoc(null); editForm.resetFields(); }}
        footer={null}
        width={500}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={handleEditSave}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="categoryId" label="Category" rules={[{ required: true }]}>
            <Select
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={editSaving} block>
              Save Changes
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* Bulk upload modal */}
      <BulkUploadModal
        open={bulkUploadOpen}
        onClose={() => setBulkUploadOpen(false)}
        funds={funds}
        categories={categories}
        onSuccess={loadDocuments}
      />
    </div>
  );
}
