import { useEffect, useState } from 'react';
import {
  Typography, Card, Table, Button, Space, Alert, Modal, Spin, message, Tag, Result,
} from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatBytes, formatUtc } from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * Everything staged, and the formal submission.
 *
 * The confirmation modal restates every file and every description before the
 * submission is made. That is deliberate friction: a submission is a formal act
 * by one accountable individual, it produces a receipt both sides rely on, and
 * files cannot be edited or withdrawn afterwards.
 */
export default function StagedSubmissionPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isCompanyAdmin = user?.companyRole === 'company_admin';

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/company/staged');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setFiles(body);
      setSelected(body.map((f) => f.id));
    } catch (err) {
      message.error(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await api.post('/company/submit', { fileIds: selected });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setReceipt(body);
      setConfirmOpen(false);
      load();
    } catch (err) {
      message.error(err.message);
    }
    setSubmitting(false);
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;

  if (receipt) {
    return (
      <Result
        status="success"
        title="Submission received"
        subTitle={(
          <Space direction="vertical">
            <Text>Your receipt reference is <Text strong>{receipt.receiptRef}</Text>. Please quote it in any correspondence.</Text>
            <Text type="secondary">
              Submitted {formatUtc(receipt.submittedAt, { long: true })} by {receipt.submittedBy}
            </Text>
          </Space>
        )}
        extra={[
          <Button key="receipts" type="primary" onClick={() => navigate('/company/receipts')}>
            View receipts
          </Button>,
          <Button key="back" onClick={() => navigate('/company')}>
            Back to information requests
          </Button>,
        ]}
      >
        <Card size="small" title={`${receipt.files.length} document(s) submitted`}>
          {receipt.files.map((f) => (
            <div key={f.id} style={{ marginBottom: 8 }}>
              <Text strong>{f.filename}</Text>
              <br />
              <Text type="secondary">{f.description}</Text>
            </div>
          ))}
        </Card>
      </Result>
    );
  }

  const columns = [
    {
      title: 'Request',
      dataIndex: 'itemRef',
      width: 160,
      render: (ref, row) => (ref
        ? <Text style={{ fontFamily: 'monospace' }}>{ref}</Text>
        : <Tag>Additional document</Tag>),
    },
    { title: 'File', dataIndex: 'filename' },
    { title: 'Description', dataIndex: 'description' },
    { title: 'Size', dataIndex: 'sizeBytes', width: 100, render: formatBytes },
    {
      title: 'Added',
      dataIndex: 'uploadedAt',
      width: 170,
      render: (d) => formatUtc(d),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Ready to submit</Title>
        <Paragraph type="secondary">
          These documents have been uploaded but have not been sent to Taranis. Nothing here is
          visible to the deal team until it is formally submitted.
        </Paragraph>
      </div>

      {!isCompanyAdmin && files.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="Only your workspace administrator can submit"
          description="You can add and edit documents here. When the set is complete, ask your
            administrator to submit it formally."
        />
      )}

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={files}
          pagination={false}
          locale={{ emptyText: 'Nothing is waiting to be submitted.' }}
          rowSelection={isCompanyAdmin ? {
            selectedRowKeys: selected,
            onChange: setSelected,
          } : undefined}
        />

        {isCompanyAdmin && files.length > 0 && (
          <Space style={{ marginTop: 16 }}>
            <Button
              type="primary"
              icon={<SendOutlined />}
              disabled={selected.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              Submit {selected.length} document{selected.length === 1 ? '' : 's'} formally
            </Button>
          </Space>
        )}
      </Card>

      <Modal
        title="Confirm your submission"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={submit}
        okText="Submit formally"
        confirmLoading={submitting}
        width={720}
      >
        <Paragraph>
          You are submitting the following documents to Taranis Capital. Once submitted they
          cannot be edited or withdrawn, and you will receive a receipt reference.
        </Paragraph>
        {files.filter((f) => selected.includes(f.id)).map((f) => (
          <Card key={f.id} size="small" style={{ marginBottom: 8 }}>
            <Space direction="vertical" size={0}>
              <Space wrap>
                {f.itemRef
                  ? <Text style={{ fontFamily: 'monospace' }}>{f.itemRef}</Text>
                  : <Tag>Additional document</Tag>}
                <Text strong>{f.filename}</Text>
                <Text type="secondary">{formatBytes(f.sizeBytes)}</Text>
              </Space>
              <Text type="secondary">{f.description}</Text>
            </Space>
          </Card>
        ))}
      </Modal>
    </Space>
  );
}
