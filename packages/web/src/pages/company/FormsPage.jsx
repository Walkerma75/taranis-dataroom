import { useEffect, useState } from 'react';
import {
  Typography, Card, Space, List, Button, Empty, Spin, Alert, Tag, message,
} from 'antd';
import { DownloadOutlined, FormOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiFetch, api } from '../../api/client.js';
import { formatBytes, formatUtc } from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * Standard Taranis forms for the company to download, complete and upload
 * against the item that asks for them (HANDOVER-CW027).
 *
 * Read-only by design and by API, exactly as "From Taranis": there is no
 * upload and no delete here because there is no route behind them. A completed
 * form goes back through the item, so it lands against the request reference
 * and appears on the receipt. "For item 14.7" links straight to that item.
 */
export default function FormsPage() {
  const navigate = useNavigate();
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null);

  useEffect(() => {
    api.get('/company/forms')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setForms(body);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const download = async (form) => {
    setDownloading(form.id);
    try {
      const res = await apiFetch(`/company/forms/${form.id}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'This form could not be downloaded.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = form.filename;
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
        <Title level={3} style={{ marginBottom: 0 }}>Forms</Title>
        <Paragraph type="secondary">
          Standard Taranis forms that some information requests ask you to complete. Download the
          form, complete and sign it, then upload it against the item shown, so that it is recorded
          on your receipt. Please do not email completed forms to us.
        </Paragraph>
      </div>

      <Card>
        {forms.length === 0 ? (
          <Empty description="There are no forms at the moment." />
        ) : (
          <List
            dataSource={forms}
            renderItem={(form) => (
              <List.Item
                actions={[
                  <Button
                    key="download"
                    type="primary"
                    icon={<DownloadOutlined />}
                    loading={downloading === form.id}
                    onClick={() => download(form)}
                  >
                    Download
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<FormOutlined style={{ fontSize: 20, color: '#2C3E35' }} />}
                  title={<Text strong>{form.title}</Text>}
                  description={(
                    <Space direction="vertical" size={2}>
                      {form.description && <Text>{form.description}</Text>}
                      <Text type="secondary">
                        {form.filename}, {formatBytes(form.sizeBytes)}
                      </Text>
                      <Text type="secondary">
                        Version {form.version}, updated {formatUtc(form.publishedAt, { long: true })}
                      </Text>
                      {form.items.length > 0 && (
                        <Space size={4} wrap>
                          {form.items.map((item) => (
                            <Tag
                              key={item.id}
                              style={{ cursor: 'pointer' }}
                              onClick={() => navigate(`/company/items/${item.id}`)}
                            >
                              For item {item.ref}
                            </Tag>
                          ))}
                        </Space>
                      )}
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
