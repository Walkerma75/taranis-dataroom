/**
 * Bounce and complaint ingestion.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN HTTPS ENDPOINT
 * ---------------------------------------------------------------------------
 * The SES production-access request committed Taranis to handling bounces and
 * complaints with suppression (HANDOVER-C002 §5.3). HANDOVER-CW011 §3.6 left
 * the transport to the implementer, offering an HTTPS SNS subscription or
 * polling. An HTTPS subscription means opening a public, unauthenticated route
 * on the ALB, with SNS signature verification and subscription-confirmation
 * handling, on a portal whose entire design premise is that nothing is
 * reachable without an invitation. That is a poor trade for a message we can
 * fetch instead, so the transport is SNS to SQS, polled from here by the same
 * process that sends. Reasoning recorded in HANDOVER-C011 §3.3.
 *
 * THREE LAYERS, AND ONLY THE MIDDLE ONE IS OURS TO BUILD:
 *
 *   1. SES's own account-level suppression list. On by default, applied whether
 *      or not any of this exists. The promise to AWS is kept from the moment
 *      the configuration set is created, even before this code runs.
 *   2. This module and `email_suppressions`, which is the layer we can SEE: it
 *      lets the portal say why a company contact never replied, and lets a
 *      withheld send be recorded in the outbox rather than attempted twice.
 *   3. The worker's pre-send check in `notifications.js`.
 *
 * UNTIL THE QUEUE EXISTS. `SES_EVENTS_QUEUE_URL` is unset, because the queue,
 * the topic and the configuration set are console work that belongs to Mark
 * under the C002 §5.1 split. With it unset the consumer does not start and says
 * so once at boot. `applySesEvent()` is fully built and tested regardless, so
 * the day the queue appears the only change is an environment variable.
 */
import { pool as defaultPool } from '../db.js';
import { suppress } from './notifications.js';

/**
 * Decide what one SES event means for the suppression list.
 *
 * Handles both shapes SES produces: the `eventType` form published by a
 * configuration set event destination, and the older `notificationType` form
 * published by an identity notification. They carry the same information under
 * different keys, and which one arrives depends on how the topic was wired,
 * which is console configuration rather than something this code can pin down.
 *
 * HARD BOUNCES ONLY. `bounceType: 'Transient'` is a full mailbox or a
 * greylisting, and suppressing on it would lock a company out of its own
 * diligence over a condition that clears itself. Those are left for the
 * retry to handle.
 *
 * @returns {{email: string, reason: 'bounce'|'complaint'}[]} addresses to suppress
 */
export function suppressionsFromEvent(event) {
  if (!event || typeof event !== 'object') return [];

  const type = event.eventType || event.notificationType;

  if (type === 'Bounce') {
    const bounce = event.bounce || {};
    if (bounce.bounceType !== 'Permanent') return [];
    return (bounce.bouncedRecipients || [])
      .map((r) => r?.emailAddress)
      .filter(Boolean)
      .map((email) => ({ email, reason: 'bounce' }));
  }

  if (type === 'Complaint') {
    const complaint = event.complaint || {};
    return (complaint.complainedRecipients || [])
      .map((r) => r?.emailAddress)
      .filter(Boolean)
      .map((email) => ({ email, reason: 'complaint' }));
  }

  // Deliveries, opens, clicks and sends all arrive on the same topic if the
  // configuration set is wired for them. They are not errors; they are simply
  // not this module's business.
  return [];
}

/**
 * Apply one event, writing suppression rows. Returns how many were written.
 *
 * The whole event is stored on the row as `detail`, so a counterparty disputing
 * a suppression can be answered with the provider's own record rather than our
 * summary of it.
 */
export async function applySesEvent(event, { pool = defaultPool } = {}) {
  const suppressions = suppressionsFromEvent(event);

  for (const { email, reason } of suppressions) {
    await suppress({ email, reason, detail: event }, pool);
  }

  return suppressions.length;
}

/**
 * Unwrap an SQS message body.
 *
 * A message that reached SQS through SNS is an SNS envelope whose `Message` is
 * the SES event as a JSON string; a message published straight to the queue is
 * the event itself. Accepting both means the queue can be re-wired without a
 * code change.
 */
export function parseQueueMessage(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }

  if (parsed && typeof parsed.Message === 'string') {
    try {
      return JSON.parse(parsed.Message);
    } catch {
      return null;
    }
  }

  return parsed;
}

/**
 * One polling pass. Exported so a test can run it deterministically.
 *
 * A message is deleted only after its suppressions are committed. If the
 * process dies in between, the message returns after its visibility timeout and
 * is applied again, which is harmless: suppressing an address that is already
 * suppressed updates the existing row.
 */
export async function pollOnce({ sqs, commands, queueUrl, pool = defaultPool, max = 10 } = {}) {
  const { ReceiveMessageCommand, DeleteMessageCommand } = commands;

  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 10,
    })
  );

  const messages = out?.Messages || [];
  let applied = 0;

  for (const message of messages) {
    const event = parseQueueMessage(message.Body);

    if (event) {
      applied += await applySesEvent(event, { pool });
    } else {
      // Unparseable: delete it anyway. Leaving it to redeliver for ever would
      // block the queue behind it, and the raw body is in the log.
      console.error('[ses-events] Could not parse a queue message:', message.Body);
    }

    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })
    );
  }

  return { received: messages.length, applied };
}

let timer = null;
let running = false;

/**
 * Start polling, if a queue is configured. Returns null when it is not, which
 * is the state everywhere today.
 */
export async function startSesEventConsumer({ env = process.env, intervalMs = 30_000, pool } = {}) {
  const queueUrl = env.SES_EVENTS_QUEUE_URL;

  if (!queueUrl) {
    console.warn(
      '[ses-events] SES_EVENTS_QUEUE_URL is not set — bounce and complaint '
      + 'events are NOT being consumed, so the suppression list will stay '
      + 'empty. SES applies its own account-level suppression regardless. See '
      + 'HANDOVER-C011 §3.3 for the four console items that turn this on.'
    );
    return null;
  }

  const sdk = await import('@aws-sdk/client-sqs');
  // No credentials argument: the task role, exactly as for SES and S3.
  const sqs = new sdk.SQSClient({ ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) });

  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce({ sqs, commands: sdk, queueUrl, pool });
    } catch (err) {
      console.error('[ses-events] Poll failed:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[ses-events] Consuming bounce and complaint events from ${queueUrl}`);
  return timer;
}

export function stopSesEventConsumer() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
