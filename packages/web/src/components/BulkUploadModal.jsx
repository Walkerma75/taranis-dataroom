/**
 * BulkUploadModal — select multiple files, review/edit metadata in a table, then upload all at once.
 */
import { useState, useEffect } from 'react';
import {
  Modal, Upload, Button, Table, Select, Input, Space, Typography, Progress, Tag, message, Alert,
} from 'antd';
import {
  UploadOutlined, InboxOutlined, DeleteOutlined,
  FilePdfOutlined, FileExcelOutlined, FileWordOutlined, FilePptOutlined,
  FileImageOutlined, FileTextOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import { api } from '../api/client.js';

const { Text, Title } = Typography;
const { Dragger } = Upload;

// Suggest a category based on filename
function guessCategory(filename, categories) {
  const lower = filename.toLowerCase();
  const categoryNames = categories.map(c => c.name.toLowerCase());

  if (lower.includes('ppm') || lower.includes('placement')) {
    return categories.find(c => c.name.toLowerCase().includes('placement'));
  }
  if (lower.includes('legal') || lower.includes('lpa') || lower.includes('subscription')) {
    return categories.find(c => c.name.toLowerCase().includes('legal'));
  }
  if (lower.includes('financial') || lower.includes('nav') || lower.includes('report')) {
    return categories.find(c => c.name.toLowerCase().includes('financial'));
  }
  if (lower.includes('pitch') || lower.includes('presentation') || lower.includes('deck')) {
    return categories.find(c => c.name.toLowerCase().includes('pitch') || c.name.toLowerCase().includes('presentation'));
  }
  if (lower.includes('technical') || lower.includes('tech') || lower.includes('due diligence')) {
    return categories.find(c => c.name.toLowerCase().includes('technical'));
  }
  if (lower.includes('letter') || lower.includes('correspondence') || lower.includes('email')) {
    return categories.find(c => c.name.toLowerCase().includes('correspondence'));
  }
  if (lower.includes('overview') || lower.includes('summary') || lower.includes('executive')) {
    return categories.find(c => c.name.toLowerCase().includes('overview'));
  }
  return null;
}

// Clean title from filename
function titleFromFilename(filename) {
  if (!filename) return '';
  let name = filename.replace(/\.[^/.]+$/, '');
  name = name.replace(/[_-]/g, ' ');
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_ ]*/, '');
  name = name.replace(/^\d+[-_ ]+/, '');
  name = name.replace(/\b\w/g, c => c.toUpperCase());
  return name.trim();
}

function fileIcon(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return <FilePdfOutlined style={{ color: '#cf1322', fontSize: 18 }} />;
  if (['doc', 'docx'].includes(ext)) return <FileWordOutlined style={{ color: '#1677ff', fontSize: 18 }} />;
  if (['xls', 'xlsx'].includes(ext)) return <FileExcelOutlined style={{ color: '#52c41a', fontSize: 18 }} />;
  if (['ppt', 'pptx'].includes(ext)) return <FilePptOutlined style={{ color: '#fa8c16', fontSize: 18 }} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'tif', 'tiff', 'bmp'].includes(ext)) return <FileImageOutlined style={{ color: '#722ed1', fontSize: 18 }} />;
  return <FileTextOutlined style={{ fontSize: 18 }} />;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BulkUploadModal({ open, onClose, funds, categories, onSuccess }) {
  const [step, setStep] = useState('select'); // 'select' | 'review' | 'uploading' | 'done'
  const [files, setFiles] = useState([]);     // { uid, file, title, categoryId, description, fundId }
  const [selectedFund, setSelectedFund] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (open) {
      setStep('select');
      setFiles([]);
      setSelectedFund(null);
      setUploadProgress(0);
      setUploadResult(null);
    }
  }, [open]);

  // Handle file selection
  const handleFilesSelected = (info) => {
    const newFiles = info.fileList.map(f => {
      // Check if we already have this file in our list
      const existing = files.find(ef => ef.uid === f.uid);
      if (existing) return existing;

      const guessedCat = guessCategory(f.name, categories);
      return {
        uid: f.uid,
        file: f.originFileObj || f,
        name: f.name,
        size: f.size,
        title: titleFromFilename(f.name),
        categoryId: guessedCat?.id || null,
        description: '',
        fundId: selectedFund,
      };
    });
    setFiles(newFiles);
  };

  // Move to review step
  const handleProceedToReview = () => {
    if (files.length === 0) {
      message.warning('Please select at least one file');
      return;
    }
    if (!selectedFund) {
      message.warning('Please select a fund');
      return;
    }
    // Set fund on all files
    setFiles(prev => prev.map(f => ({ ...f, fundId: selectedFund })));
    setStep('review');
  };

  // Update a field on a specific file
  const updateFile = (uid, field, value) => {
    setFiles(prev => prev.map(f => f.uid === uid ? { ...f, [field]: value } : f));
  };

  // Remove a file from the list
  const removeFile = (uid) => {
    setFiles(prev => prev.filter(f => f.uid !== uid));
  };

  // Validate before upload
  const canUpload = () => {
    return files.every(f => f.title && f.categoryId && f.fundId);
  };

  // Run the bulk upload
  const handleUpload = async () => {
    if (!canUpload()) {
      message.error('Please fill in a title and category for every file');
      return;
    }

    setStep('uploading');
    setUploadProgress(0);

    try {
      const formData = new FormData();

      // Add files in order
      files.forEach(f => {
        formData.append('files', f.file);
      });

      // Add metadata as a JSON array matching the file order
      const metadata = files.map(f => ({
        fundId: f.fundId,
        categoryId: f.categoryId,
        title: f.title,
        description: f.description || '',
        downloadAllowed: true,
      }));
      formData.append('metadata', JSON.stringify(metadata));

      // Use XMLHttpRequest for progress tracking
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const token = localStorage.getItem('accessToken');

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(data);
            } else if (xhr.status === 207) {
              resolve(data); // partial success
            } else {
              reject(new Error(data.error || 'Upload failed'));
            }
          } catch {
            reject(new Error('Invalid response from server'));
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

        const apiUrl = import.meta.env.VITE_API_URL || '/api';
        xhr.open('POST', `${apiUrl}/documents/bulk`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });

      setUploadResult(result);
      setStep('done');

      if (result.failed === 0) {
        message.success(`Successfully uploaded ${result.succeeded} document${result.succeeded !== 1 ? 's' : ''}`);
      } else {
        message.warning(`${result.succeeded} uploaded, ${result.failed} failed`);
      }
    } catch (err) {
      message.error(err.message);
      setStep('review'); // go back to review so they can retry
    }
  };

  const handleDone = () => {
    onSuccess?.();
    onClose();
  };

  // ── Review table columns ──
  const reviewColumns = [
    {
      title: '',
      key: 'icon',
      width: 40,
      render: (_, record) => fileIcon(record.name),
    },
    {
      title: 'File',
      key: 'file',
      width: 180,
      render: (_, record) => (
        <div>
          <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: record.name }}>{record.name}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>{formatFileSize(record.size)}</Text>
        </div>
      ),
    },
    {
      title: 'Title',
      key: 'title',
      render: (_, record) => (
        <Input
          size="small"
          value={record.title}
          onChange={e => updateFile(record.uid, 'title', e.target.value)}
          status={!record.title ? 'error' : undefined}
          placeholder="Required"
        />
      ),
    },
    {
      title: 'Category',
      key: 'category',
      width: 220,
      render: (_, record) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={record.categoryId}
          onChange={v => updateFile(record.uid, 'categoryId', v)}
          options={categories.map(c => ({ value: c.id, label: c.name }))}
          status={!record.categoryId ? 'error' : undefined}
          placeholder="Required"
        />
      ),
    },
    {
      title: 'Description',
      key: 'description',
      width: 200,
      render: (_, record) => (
        <Input
          size="small"
          value={record.description}
          onChange={e => updateFile(record.uid, 'description', e.target.value)}
          placeholder="Optional"
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, record) => (
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeFile(record.uid)}
        />
      ),
    },
  ];

  // ── Render by step ──
  const renderSelect = () => (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Text strong>Fund</Text>
        <Select
          style={{ width: '100%', marginTop: 4 }}
          placeholder="Select the fund these documents belong to"
          value={selectedFund}
          onChange={setSelectedFund}
          options={funds.map(f => ({ value: f.id, label: f.name }))}
        />
      </div>

      <Dragger
        multiple
        beforeUpload={() => false}
        onChange={handleFilesSelected}
        fileList={files.map(f => ({ uid: f.uid, name: f.name, status: 'done' }))}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.svg,.webp,.tif,.tiff,.bmp"
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">Click or drag files here</p>
        <p className="ant-upload-hint">
          Supports PDF, Word, Excel, PowerPoint, and image files. Select as many as you need.
        </p>
      </Dragger>

      {files.length > 0 && (
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Text type="secondary" style={{ marginRight: 12 }}>{files.length} file{files.length !== 1 ? 's' : ''} selected</Text>
          <Button type="primary" onClick={handleProceedToReview}>
            Next: Review &amp; Edit Details
          </Button>
        </div>
      )}
    </div>
  );

  const renderReview = () => (
    <div>
      <Alert
        type="info"
        showIcon
        message={`Uploading ${files.length} file${files.length !== 1 ? 's' : ''} to ${funds.find(f => f.id === selectedFund)?.name}`}
        description="Check the titles and categories below. The script has guessed where it can — just correct anything that's wrong."
        style={{ marginBottom: 16 }}
      />

      <Table
        dataSource={files}
        columns={reviewColumns}
        rowKey="uid"
        pagination={false}
        size="small"
        scroll={{ y: 400 }}
      />

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Button onClick={() => setStep('select')}>Back</Button>
        <Space>
          <Text type="secondary">{files.length} file{files.length !== 1 ? 's' : ''}</Text>
          <Button
            type="primary"
            onClick={handleUpload}
            disabled={!canUpload()}
          >
            Upload All
          </Button>
        </Space>
      </div>
    </div>
  );

  const renderUploading = () => (
    <div style={{ textAlign: 'center', padding: '40px 0' }}>
      <Title level={4}>Uploading documents...</Title>
      <Progress percent={uploadProgress} style={{ maxWidth: 400, margin: '24px auto' }} />
      <Text type="secondary">
        Uploading {files.length} file{files.length !== 1 ? 's' : ''} to S3. Please don't close this window.
      </Text>
    </div>
  );

  const renderDone = () => (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      {uploadResult && uploadResult.failed === 0 ? (
        <>
          <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a', marginBottom: 16 }} />
          <Title level={4}>All done!</Title>
          <Text>{uploadResult.succeeded} document{uploadResult.succeeded !== 1 ? 's' : ''} uploaded successfully.</Text>
        </>
      ) : uploadResult ? (
        <>
          <Title level={4}>Upload complete with issues</Title>
          <Text type="success">{uploadResult.succeeded} succeeded</Text>
          {uploadResult.failed > 0 && (
            <div style={{ marginTop: 8 }}>
              <Text type="danger">{uploadResult.failed} failed:</Text>
              {uploadResult.errors?.map((e, i) => (
                <div key={i}><Tag color="red">{e.file}</Tag> {e.error}</div>
              ))}
            </div>
          )}
        </>
      ) : null}

      <div style={{ marginTop: 24 }}>
        <Button type="primary" onClick={handleDone}>Close</Button>
      </div>
    </div>
  );

  return (
    <Modal
      title="Bulk Upload Documents"
      open={open}
      onCancel={step === 'uploading' ? undefined : onClose}
      footer={null}
      width={step === 'review' ? 900 : 600}
      closable={step !== 'uploading'}
      maskClosable={step !== 'uploading'}
      destroyOnClose
    >
      {step === 'select' && renderSelect()}
      {step === 'review' && renderReview()}
      {step === 'uploading' && renderUploading()}
      {step === 'done' && renderDone()}
    </Modal>
  );
}
