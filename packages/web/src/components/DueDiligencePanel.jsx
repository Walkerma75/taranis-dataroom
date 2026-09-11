import { Card, Row, Col, Statistic, Typography, Space, Tag, Progress, Table, Tooltip } from 'antd';
import { InboxOutlined, SolutionOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  levelColour, LEVEL_LABELS, ageCaption, ACTIVITY_LABELS, STATE_LABELS, formatUtc,
} from '../pages/company/irlDisplay.js';

const { Title, Text } = Typography;

/**
 * The dashboard's due diligence section: who owes the next move, on what, and
 * for how long.
 *
 * WHY THIS IS NOT A SECOND PIPELINE TABLE. The pipeline already lists every
 * company with its counts and sorts by activity, and it is the right screen for
 * working through them. This answers a different question, the one an admin
 * arrives at the dashboard with: is anything going stale, and is it mine or
 * theirs. So the rows carry ageing rather than gates, they sort worst-first
 * rather than newest-first, and each one is a way into the company rather than
 * a place to act.
 *
 * EVERY JUDGEMENT HERE WAS MADE ON THE SERVER. The levels, the day counts, the
 * ordering and the progress denominator all arrive decided, from
 * `services/dd-summary.js`. Nothing in this file computes an age, because the
 * working-day rule reimplemented in a browser is the working-day rule with two
 * answers (CW020 §3.1).
 */

/** The two headline tiles. Colour is the worst level in the bucket. */
function HeadlineTile({ title, value, caption, level, icon, onClick }) {
  return (
    <Card hoverable={!!onClick} onClick={onClick} style={{ height: '100%' }}>
      <Statistic
        title={title}
        value={value}
        prefix={icon}
        valueStyle={{ color: levelColour(level) }}
      />
      {caption && (
        <Text type="secondary" style={{ fontSize: 12 }}>{caption}</Text>
      )}
    </Card>
  );
}

/** The flag on a company row. Nothing at all when there is nothing to flag. */
function LevelTag({ level }) {
  if (level === 'none') return null;
  return (
    <Tag color={levelColour(level)} style={{ color: '#fff', borderColor: 'transparent' }}>
      {LEVEL_LABELS[level]}
    </Tag>
  );
}

/**
 * One bucket's cell: the count, and underneath it what it is made of.
 *
 * The breakdown is there because the totals are sums of unlike things. Four
 * awaiting Taranis might be four unopened submissions or one unopened and three
 * half-read, and those are different mornings.
 */
function BucketCell({ total, breakdown, caption, level }) {
  if (!total) return <Text type="secondary">0</Text>;
  return (
    <Space direction="vertical" size={0}>
      <Text strong style={{ color: levelColour(level) }}>{total}</Text>
      <Text type="secondary" style={{ fontSize: 11 }}>{breakdown}</Text>
      {caption && <Text type="secondary" style={{ fontSize: 11 }}>{caption}</Text>}
    </Space>
  );
}

export default function DueDiligencePanel({ summary }) {
  const navigate = useNavigate();

  // No active counterparties means no section at all, rather than an empty one.
  // A heading over a blank card reads as something broken (CW020 §3.3).
  if (!summary || summary.companies.length === 0) return null;

  const { awaitingTaranis, awaitingCompany, companies, recentActivity } = summary;

  const columns = [
    {
      title: 'Company',
      key: 'name',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Space size={8}>
            <Text strong>{row.name}</Text>
            <LevelTag level={row.level} />
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.fundName}</Text>
        </Space>
      ),
    },
    {
      title: 'Awaiting Taranis',
      key: 'awaitingTaranis',
      width: 170,
      align: 'center',
      render: (_, row) => (
        <BucketCell
          total={row.awaitingTaranis.total}
          breakdown={`${row.awaitingTaranis.received} to open, ${row.awaitingTaranis.inReview} in review`}
          caption={ageCaption(row.awaitingTaranis, 'working')}
          level={row.awaitingTaranis.level}
        />
      ),
    },
    {
      title: 'Awaiting company',
      key: 'awaitingCompany',
      width: 190,
      align: 'center',
      render: (_, row) => (
        <BucketCell
          total={row.awaitingCompany.total}
          breakdown={[
            row.awaitingCompany.attentionFiles
              ? `${row.awaitingCompany.attentionFiles} needing attention`
              : null,
            row.awaitingCompany.unstartedItems
              ? `${row.awaitingCompany.unstartedItems} not started`
              : null,
          ].filter(Boolean).join(', ')}
          caption={ageCaption(row.awaitingCompany, 'calendar')}
          level={row.awaitingCompany.level}
        />
      ),
    },
    {
      title: 'Checklist',
      key: 'irl',
      width: 180,
      render: (_, row) => (
        row.irl.countable === 0
          ? <Text type="secondary">Not seeded</Text>
          : (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Progress percent={row.irl.percentComplete} size="small" strokeColor="#3A5247" />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.irl.completed} of {row.irl.countable} completed
              </Text>
            </Space>
          )
      ),
    },
    {
      title: 'Last activity',
      key: 'lastActivity',
      dataIndex: 'lastActivity',
      width: 170,
      render: (d) => (d ? formatUtc(d) : <Text type="secondary">None</Text>),
    },
  ];

  return (
    <div style={{ marginTop: 32 }}>
      <Title level={4}>Due diligence</Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} md={8}>
          <HeadlineTile
            title="Awaiting Taranis"
            value={awaitingTaranis.total}
            icon={<InboxOutlined />}
            level={awaitingTaranis.level}
            caption={[
              `${awaitingTaranis.received} to open, ${awaitingTaranis.inReview} in review`,
              ageCaption(awaitingTaranis, 'working'),
            ].filter(Boolean).join(' — ')}
            // Both statuses, because the tile counts both. The queue defaults to
            // 'received' for every other caller.
            onClick={() => navigate('/admin/review-queue?status=all')}
          />
        </Col>
        <Col xs={24} sm={12} md={8}>
          <HeadlineTile
            title="Awaiting company"
            value={awaitingCompany.total}
            icon={<SolutionOutlined />}
            level={awaitingCompany.level}
            caption={[
              [
                awaitingCompany.attentionFiles
                  ? `${awaitingCompany.attentionFiles} needing attention`
                  : null,
                awaitingCompany.unstartedItems
                  ? `${awaitingCompany.unstartedItems} not started`
                  : null,
              ].filter(Boolean).join(', '),
              ageCaption(awaitingCompany, 'calendar'),
            ].filter(Boolean).join(' — ')}
          />
        </Col>
      </Row>

      <Card
        size="small"
        styles={{ body: { padding: 0 } }}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={companies}
          pagination={false}
          size="small"
          onRow={(row) => ({
            style: { cursor: 'pointer' },
            onClick: () => navigate(`/admin/companies/${row.id}`),
          })}
        />
      </Card>

      {recentActivity.length > 0 && (
        <Card size="small" title="Recent activity" style={{ marginTop: 16 }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {recentActivity.map((event) => (
              <div key={`${event.kind}-${event.at}-${event.subject}`}>
                <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
                  {formatUtc(event.at)}
                </Text>
                <Tooltip title={event.actorSide === 'company' ? 'Company side' : 'Taranis side'}>
                  <Tag
                    color={event.actorSide === 'company' ? '#3A5247' : '#8C8C8C'}
                    style={{ color: '#fff', borderColor: 'transparent' }}
                  >
                    {event.actorSide === 'company' ? 'Company' : 'Taranis'}
                  </Tag>
                </Tooltip>
                <Text>
                  {event.companyName}: {event.actorName} {ACTIVITY_LABELS[event.kind]}
                  {event.kind === 'status' ? ` ${STATE_LABELS[event.detail] || event.detail}` : ''}
                  {event.subject ? ` ${event.subject}` : ''}
                  {event.itemRef ? ` (${event.itemRef})` : ''}
                </Text>
              </div>
            ))}
          </Space>
        </Card>
      )}
    </div>
  );
}
