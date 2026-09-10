import { useEffect } from 'react';
import { Modal, Form, Select, Input, Checkbox, Alert, message } from 'antd';
import { api } from '../api/client.js';
import {
  FILE_STATUS_OPTIONS, noteHintFor, noteRequiredFor, NOTE_REQUIRED_MESSAGE, isResponse,
} from '../pages/company/irlDisplay.js';

/**
 * The one Set status dialog, used by the company Files tab and the Review
 * Queue.
 *
 * There were two hard-coded copies, and CW010 had already had to pull their
 * option lists into one constant after they drifted. CW026 gave both the same
 * two additions, so they became one component rather than two edits:
 *
 *   * a "cannot provide" response shows Completed as "Accepted", because
 *     accepting "we do not hold this" is not receiving a completed document;
 *   * accepting a 'not_applicable' response offers a pre-ticked "Also mark item
 *     {ref} Not applicable", so the reviewer's decision about the item is
 *     explicit and made in the same action (HANDOVER-CW026 §3.6). The server
 *     applies it in the same transaction and audits it.
 *
 * `initialStatus` is what the Status field opens on: the file's own status on
 * the Files tab, In review on the queue, where taking a file up is the usual
 * next step.
 */
export default function FileStatusModal({ file, initialStatus, onClose, onSaved }) {
  const [form] = Form.useForm();
  const response = isResponse(file);

  useEffect(() => {
    if (!file) return;
    form.resetFields();
    form.setFieldsValue({ status: initialStatus || file.status, alsoMarkItemNotApplicable: true });
  }, [file]);

  const offersTick = (status) => response
    && file?.statementReason === 'not_applicable'
    && status === 'completed'
    && !!file?.itemRef;

  const options = FILE_STATUS_OPTIONS.map((o) => (
    response && o.value === 'completed' ? { ...o, label: 'Accepted' } : o
  ));

  const save = async (values) => {
    const body = { status: values.status, note: values.note };
    if (offersTick(values.status)) body.alsoMarkItemNotApplicable = !!values.alsoMarkItemNotApplicable;
    try {
      const res = await api.patch(`/company-files/${file.id}/status`, body);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      message.success(body.alsoMarkItemNotApplicable
        ? `Status updated, and item ${file.itemRef} marked Not applicable`
        : 'Status updated');
      onSaved?.();
    } catch (err) {
      message.error(err.message);
    }
  };

  return (
    <Modal
      title={`Set status: ${file?.filename || ''}`}
      open={!!file}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Save"
    >
      {response && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="A response, not a document"
          description={file.description}
        />
      )}
      <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
        <Form.Item name="status" label="Status" rules={[{ required: true, message: 'Please choose a status' }]}>
          <Select options={options} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, next) => prev.status !== next.status}>
          {({ getFieldValue }) => (
            <>
              <Form.Item
                name="note"
                label="Note"
                extra={noteHintFor(getFieldValue('status'))}
                rules={noteRequiredFor(getFieldValue('status'))
                  ? [{ required: true, message: NOTE_REQUIRED_MESSAGE }]
                  : []}
              >
                <Input.TextArea rows={3} />
              </Form.Item>
              {offersTick(getFieldValue('status')) && (
                <Form.Item name="alsoMarkItemNotApplicable" valuePropName="checked">
                  <Checkbox>Also mark item {file.itemRef} Not applicable</Checkbox>
                </Form.Item>
              )}
            </>
          )}
        </Form.Item>
      </Form>
    </Modal>
  );
}
