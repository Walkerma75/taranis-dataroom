import { Tag, Typography, Space } from 'antd';
import { Link } from 'react-router-dom';
import {
  NO_DOCUMENT_LABEL, NO_DOCUMENT_COLOUR, STATEMENT_REASON_LABELS, expectedByText, isResponse,
} from './irlDisplay.js';

const { Text } = Typography;

/**
 * The pieces every screen uses to show a "cannot provide" response
 * (HANDOVER-CW026), so the tag, the reason and the date read the same to a
 * company user and to a reviewer. The label itself is the row's `filename`.
 */

/** "No document", where a file would show its size. */
export function NoDocumentTag() {
  return (
    <Tag color={NO_DOCUMENT_COLOUR} style={{ color: '#fff', borderColor: 'transparent' }}>
      {NO_DOCUMENT_LABEL}
    </Tag>
  );
}

/**
 * The reason, and the expected date or the item it was provided under.
 *
 * `itemHref` builds a link to the related item where the screen has one to go
 * to (the company's own item pages); without it the ref is shown as text.
 */
export function ResponseMeta({ file, itemHref }) {
  if (!isResponse(file)) return null;
  return (
    <Space direction="vertical" size={0}>
      <Text type="secondary">Reason: {STATEMENT_REASON_LABELS[file.statementReason] || file.statementReason}</Text>
      {file.statementReason === 'not_yet_available' && file.expectedDate && (
        <Text type="secondary">{expectedByText(file.expectedDate)}</Text>
      )}
      {file.statementReason === 'provided_elsewhere' && file.relatedItemRef && (
        <Text type="secondary">
          Provided under{' '}
          {itemHref && file.relatedItemId
            ? <Link to={itemHref(file.relatedItemId)}>{file.relatedItemRef}</Link>
            : file.relatedItemRef}
        </Text>
      )}
    </Space>
  );
}
