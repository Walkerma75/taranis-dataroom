import { useEffect, useState } from 'react';
import {
  Typography, Card, Tag, Space, Progress, Row, Col, Statistic, Empty, Spin, Alert, Collapse, List, Badge,
} from 'antd';
import { WarningOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import {
  STATE_LABELS, STATE_COLOURS, PRIORITY_LABELS, PRIORITY_COLOURS, groupBySection,
} from './irlDisplay.js';

const { Title, Text, Paragraph } = Typography;

/**
 * The company's checklist.
 *
 * Items needing attention are pinned above everything else, because they are
 * the only ones where Taranis is waiting on a specific correction rather than
 * on a first submission.
 */
export default function WorkspacePage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/company/workspace')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        setData(body);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />;
  if (error) return <Alert message={error} type="error" showIcon />;

  const { progress, items } = data;
  const attention = items.filter((i) => i.state === 'attention_needed');
  const sections = groupBySection(items);

  const itemRow = (item) => (
    <List.Item
      key={item.id}
      onClick={() => navigate(`/company/items/${item.id}`)}
      style={{ cursor: 'pointer' }}
      actions={[<RightOutlined key="go" style={{ color: '#bfbfbf' }} />]}
    >
      <List.Item.Meta
        title={(
          <Space size={8} wrap>
            <Text strong style={{ fontFamily: 'monospace' }}>{item.ref}</Text>
            <Text>{item.description}</Text>
          </Space>
        )}
        description={(
          <Space size={8} wrap style={{ marginTop: 4 }}>
            <Tag color={STATE_COLOURS[item.state]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {STATE_LABELS[item.state]}
            </Tag>
            <Tag color={PRIORITY_COLOURS[item.priority]} style={{ color: '#fff', borderColor: 'transparent' }}>
              {PRIORITY_LABELS[item.priority]}
            </Tag>
            {item.submittedFiles > 0 && (
              <Text type="secondary">{item.submittedFiles} submitted</Text>
            )}
            {item.stagedFiles > 0 && (
              <Badge status="processing" text={`${item.stagedFiles} ready to submit`} />
            )}
            {item.note_for_company && <Text type="secondary">{item.note_for_company}</Text>}
          </Space>
        )}
      />
    </List.Item>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 0 }}>Information requests</Title>
        <Paragraph type="secondary">
          These are the items Taranis still needs from {data.company.legalName}. Anything already
          held is not shown, so this list is only what is outstanding.
        </Paragraph>
      </div>

      <Card>
        <Row gutter={24} align="middle">
          <Col xs={24} md={8}>
            <Progress
              type="dashboard"
              percent={progress.percentComplete}
              strokeColor="#3A5247"
              size={140}
            />
          </Col>
          <Col xs={24} md={16}>
            <Row gutter={16}>
              <Col span={8}>
                <Statistic title="Outstanding" value={progress.counts.outstanding || 0} />
              </Col>
              <Col span={8}>
                <Statistic title="With Taranis" value={(progress.counts.received || 0) + (progress.counts.in_review || 0)} />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Needs attention"
                  value={progress.counts.attention_needed || 0}
                  valueStyle={{ color: progress.counts.attention_needed ? '#B54A32' : undefined }}
                />
              </Col>
            </Row>
            <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
              {progress.completed} of {progress.countable} requests completed.
            </Text>
          </Col>
        </Row>
      </Card>

      {attention.length > 0 && (
        <Card
          title={<Space><WarningOutlined style={{ color: '#B54A32' }} />Needs your attention</Space>}
          styles={{ header: { background: '#FDF3F0' } }}
        >
          <List dataSource={attention} renderItem={itemRow} />
        </Card>
      )}

      {items.length === 0 ? (
        <Empty description="There is nothing to provide at the moment." />
      ) : (
        <Collapse
          defaultActiveKey={sections.map((s) => s.section)}
          items={sections.map((s) => ({
            key: s.section,
            label: (
              <Space>
                <Text strong>{s.section}</Text>
                <Text type="secondary">
                  {s.items.filter((i) => i.state === 'completed').length} of {s.items.length} completed
                </Text>
              </Space>
            ),
            children: <List dataSource={s.items} renderItem={itemRow} />,
          }))}
        />
      )}
    </Space>
  );
}
