import { useEffect, useState } from 'react';
import {
  Typography, Card, Space, List, Button, Empty, Spin, Alert, message,
} from 'antd';
import { DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import { apiFetch, api } from '../../api/client.js';
import { formatBytes, formatUtc } from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * Documents Taranis has sent to this company.
 *
 * Read-only by design and by API: there is no upload, no delete and no
 * re-publish on this screen, because there is no route behind them. Anything
 * the company wants to send goes through the checklist, where it lands against
 * a specific request reference and carries a receipt.
 *
 * Every row says who published it and when. A document that arrives from a
 * portal with no name against it is less accountable than the email it
 * replaced, and this is meant to be more.
 */
export default function SharedDocumentsPage() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null);

  useEffect(() => {
    api.get('/company/shared-files')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setDocuments(body);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const download = async (doc) => {
    setDownloading(doc.id);
    try {
      const res = await apiFetch(`/company/shared-files/${doc.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'This document could not be downloaded.');
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
    setDownloading(null);
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (error) return <Alert message={error} type="error" showIcon />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', maxWidth: 960 }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Documents from Taranis</Title>
        <Paragraph type="secondary">
          These are documents Taranis has shared with you. They are for reference. To send us
          something, use the information requests, so that what you upload is recorded against
          the item it answers and appears on your receipt.
        </Paragraph>
      </div>

      <Card>
        {documents.length === 0 ? (
          <Empty description="Taranis has not shared any documents with you yet." />
        ) : (
          <List
            dataSource={documents}
            renderItem={(doc) => (
              <List.Item
                actions={[
                  <Button
                    key="download"
                    type="primary"
                    icon={<DownloadOutlined />}
                    loading={downloading === doc.id}
                    onClick={() => download(doc)}
                  >
                    Download
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<FileTextOutlined style={{ fontSize: 20, color: '#2C3E35' }} />}
                  title={<Text strong>{doc.title}</Text>}
                  description={(
                    <Space direction="vertical" size={2}>
                      {doc.description && <Text>{doc.description}</Text>}
                      <Text type="secondary">
                        {doc.filename}, {formatBytes(doc.sizeBytes)}
                      </Text>
                      <Text type="secondary">
                        Shared by {doc.publishedBy} on {formatUtc(doc.publishedAt, { long: true })}
                      </Text>
                    </Space>
                  )}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}
