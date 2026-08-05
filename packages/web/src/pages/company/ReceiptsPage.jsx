import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Space, Button, Modal, Spin, message, Descriptions, List, Tag,
} from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { api } from '../../api/client.js';
import { formatBytes, formatUtc } from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * Past submission receipts.
 *
 * Timestamps are shown in UTC and labelled as such. The two sides of this
 * exchange are not in the same time zone, and the receipt is the record both
 * refer back to.
 */
export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    api.get('/company/receipts')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setReceipts(body);
      })
      .catch((err) => message.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const openReceipt = async (id) => {
    setDetailLoading(true);
    try {
      const res = await api.get(`/company/receipts/${id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setOpen(body);
    } catch (err) {
      message.error(err.message);
    }
    setDetailLoading(false);
  };

  const columns = [
    {
      title: 'Receipt',
      dataIndex: 'receiptRef',
      render: (ref) => <Text strong style={{ fontFamily: 'monospace' }}>{ref}</Text>,
    },
    {
      title: 'Submitted',
      dataIndex: 'submittedAt',
      render: (d) => formatUtc(d),
    },
    { title: 'Submitted by', dataIndex: 'submittedBy' },
    { title: 'Documents', dataIndex: 'fileCount', width: 120 },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_, row) => (
        <Button type="link" onClick={() => openReceipt(row.id)}>View</Button>
      ),
    },
  ];

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Receipts</Title>
        <Paragraph type="secondary">
          A record of every formal submission you have made. Quote the receipt reference in any
          correspondence about a submission.
        </Paragraph>
      </div>

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={receipts}
          pagination={false}
          loading={detailLoading}
          locale={{ emptyText: 'You have not submitted anything yet.' }}
        />
      </Card>

      <Modal
        open={!!open}
        onCancel={() => setOpen(null)}
        title="Submission receipt"
        width={760}
        footer={[
          <Button key="print" icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print
          </Button>,
          <Button key="close" type="primary" onClick={() => setOpen(null)}>Close</Button>,
        ]}
      >
        {open && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="Receipt reference">
                <Text strong style={{ fontFamily: 'monospace' }}>{open.receiptRef}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Company">{open.companyName}</Descriptions.Item>
              <Descriptions.Item label="Submitted by">
                {open.submittedBy} ({open.submittedByEmail})
              </Descriptions.Item>
              <Descriptions.Item label="Submitted at">
                {formatUtc(open.submittedAt, { long: true })}
              </Descriptions.Item>
            </Descriptions>

            <List
              header={<Text strong>{open.files.length} document(s)</Text>}
              bordered
              dataSource={open.files}
              renderItem={(f) => (
                <List.Item>
                  <List.Item.Meta
                    title={(
                      <Space wrap>
                        {f.itemRef
                          ? <Text style={{ fontFamily: 'monospace' }}>{f.itemRef}</Text>
                          : <Tag>Additional document</Tag>}
                        <Text>{f.filename}</Text>
                      </Space>
                    )}
                    description={(
                      <Space direction="vertical" size={0}>
                        <Text>{f.description}</Text>
                        <Text type="secondary">{formatBytes(f.sizeBytes)}</Text>
                      </Space>
                    )}
                  />
                </List.Item>
              )}
            />
          </Space>
        )}
      </Modal>
    </Space>
  );
}
