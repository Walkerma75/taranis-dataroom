/**
 * Email sending.
 *
 * This module does one thing: it puts a rendered message on the wire. It does
 * not decide who gets email, it does not render, it does not retry, and it does
 * not know what an invitation is. Those live in `services/notifications.js` and
 * `services/email-templates/`. Keeping the transport this thin is what lets the
 * whole notification path be exercised in tests with no AWS credential, no
 * network and no verified identity.
 *
 * Same injectable shape as `storage.js` and `scanner.js`:
 *
 *   send({ to, subject, html, text }) -> Promise<{ messageId }>
 *   kind        -> 'ses' | 'log' | 'memory'
 *   describe()  -> string, for startup logging
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO SES CREDENTIAL, AND NONE SHOULD EVER BE CREATED
 * ---------------------------------------------------------------------------
 * The code brief §5 specified SMTP credentials in Secrets Manager under
 * `taranis-dataroom/ses/credentials`. That was superseded before any of it was
 * built (HANDOVER-C002 §5.2): the SES v2 SDK picks up the ECS task role
 * `taranis-dataroom-task-role` from the container credential chain, exactly as
 * the S3 client does. There is then no SES credential in existence to leak, to
 * rotate, or to forget to rotate.
 *
 * If sending fails with an authorisation error in production, the fix is the
 * IAM policy on the task role. It is never to create a secret.
 *
 * IDENTITY. Sender is `Taranis Capital Dataroom
 * <notifications@mail.taraniscapital.com>` (HANDOVER-C003 §5.5 decision 4). The
 * `mail.taraniscapital.com` subdomain is DKIM-signed with a custom MAIL FROM of
 * `bounce.mail.taraniscapital.com`, and production access was granted on
 * 2026-08-06: 50,000 messages a day at 14 a second, case 178594622700053.
 *
 * QUOTA IS NOT A DESIGN CONSTRAINT. 50,000 a day against a pilot of one company
 * means no batching, no rate management and no digest beyond what SES itself
 * enforces (HANDOVER-CW011 §5.5). The worker's serial drain is already far
 * inside 14 a second.
 *
 * CONFIGURATION SET. `SES_CONFIGURATION_SET`, when set, is passed on every
 * send. That is what routes bounce and complaint events to SNS, which is what
 * feeds the suppression list. It is deliberately optional: the configuration
 * set is created in the console (HANDOVER-C002 §5.1 splits console from code),
 * and the platform must be able to send before it exists rather than after.
 */
import { SENDER_NAME, SENDER_ADDRESS } from './email-templates/index.js';

/** The RFC 5322 From value used on every message. */
export const DEFAULT_FROM = `${SENDER_NAME} <${SENDER_ADDRESS}>`;

/**
 * Thrown for a permanent rejection, as opposed to a transient one.
 *
 * The distinction matters to the worker: retrying a message SES has told us it
 * will never accept burns attempts and delays every message behind it, so a
 * permanent failure fails the row immediately instead.
 */
export class PermanentSendError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PermanentSendError';
    this.code = 'PERMANENT_SEND_FAILURE';
    this.cause = cause;
  }
}

/**
 * SES error names that mean "do not try this again".
 *
 * Everything not listed is treated as transient and retried, which is the safe
 * default: a message retried unnecessarily is a duplicate at worst, whereas a
 * message abandoned on a throttle is a company never hearing that its
 * submission was received.
 */
const PERMANENT_ERRORS = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
]);

export class SesMailer {
  /**
   * @param {object}  opts
   * @param {object}  opts.client            - anything with `send(command)`
   * @param {object}  opts.commands          - { SendEmailCommand }
   * @param {string} [opts.from]
   * @param {string} [opts.configurationSet]
   * @param {string} [opts.region]           - recorded for logging only
   */
  constructor({ client, commands, from = DEFAULT_FROM, configurationSet, region } = {}) {
    this.kind = 'ses';
    this.client = client;
    this.commands = commands;
    this.from = from;
    this.configurationSet = configurationSet;
    this.region = region;
  }

  describe() {
    return `SES v2 as ${this.from}${this.region ? ` (${this.region})` : ''}`
      + `${this.configurationSet ? `, configuration set ${this.configurationSet}` : ', no configuration set'}`;
  }

  async send({ to, subject, html, text }) {
    const { SendEmailCommand } = this.commands;

    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [to] },
          ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
            },
          },
        })
      );
      return { messageId: out?.MessageId ?? null };
    } catch (err) {
      if (PERMANENT_ERRORS.has(err?.name)) {
        throw new PermanentSendError(`SES rejected the message: ${err.name}: ${err.message}`, {
          cause: err,
        });
      }
      throw err;
    }
  }
}

/**
 * Build an SES-backed mailer.
 *
 * The SDK is imported lazily so tests, local development and the in-memory
 * double never load it, the same reason `createS3Storage` does.
 */
export async function createSesMailer({ region, from, configurationSet, client, commands } = {}) {
  let resolvedClient = client;
  let resolvedCommands = commands;

  if (!resolvedClient || !resolvedCommands) {
    const sdk = await import('@aws-sdk/client-sesv2');
    resolvedCommands = resolvedCommands || sdk;
    // No credentials argument, deliberately. See the header.
    resolvedClient = resolvedClient || new sdk.SESv2Client({ ...(region ? { region } : {}) });
  }

  return new SesMailer({
    client: resolvedClient,
    commands: resolvedCommands,
    from,
    configurationSet,
    region,
  });
}

/**
 * Development backend: prints what would have been sent and sends nothing.
 *
 * Chosen over "send for real from a developer's laptop", which needs a
 * credential nobody should have, and over silently discarding, which makes a
 * broken notification look like a working one.
 */
export class LogMailer {
  constructor({ logger = console } = {}) {
    this.kind = 'log';
    this.logger = logger;
    this.sent = 0;
  }

  describe() {
    return 'LOG — no email is sent, messages are printed to the log (development only)';
  }

  async send({ to, subject }) {
    this.sent++;
    this.logger.log(`[email] (not sent) to=${to} subject=${subject}`);
    return { messageId: `log-${this.sent}` };
  }
}

/** The test double. Keeps every message for assertions. */
export class MemoryMailer {
  constructor({ failWith = null } = {}) {
    this.kind = 'memory';
    this.messages = [];
    /** Set to an Error to make the next sends fail; used by the retry tests. */
    this.failWith = failWith;
  }

  describe() {
    return `in-memory (${this.messages.length} message(s)) — test double only`;
  }

  async send(message) {
    if (this.failWith) throw this.failWith;
    this.messages.push(message);
    return { messageId: `memory-${this.messages.length}` };
  }

  /** Test helper: every message sent to one address. */
  to(address) {
    return this.messages.filter((m) => m.to === address);
  }

  /** Test helper: the most recent message. */
  last() {
    return this.messages[this.messages.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Selection and injection
// ---------------------------------------------------------------------------

/**
 * `EMAIL_BACKEND` is unset everywhere today, so this picks SES in production
 * and the log backend elsewhere. Read from the environment rather than
 * hard-coded so that turning sending off in production, if it ever has to be
 * turned off in a hurry, is a task-definition change and not a deploy.
 */
export async function createMailerFromEnv(env = process.env) {
  const backend = (env.EMAIL_BACKEND || (env.NODE_ENV === 'production' ? 'ses' : 'log')).toLowerCase();

  if (backend === 'ses') {
    return createSesMailer({
      region: env.AWS_REGION,
      from: env.EMAIL_FROM || DEFAULT_FROM,
      configurationSet: env.SES_CONFIGURATION_SET,
    });
  }

  if (backend === 'memory') return new MemoryMailer();

  return new LogMailer();
}

let mailerPromise = null;

/** Lazily built singleton. Awaited by the worker. */
export function getMailer() {
  if (!mailerPromise) mailerPromise = createMailerFromEnv();
  return mailerPromise;
}

/** Inject a mailer. Tests only. */
export function setMailer(mailer) {
  mailerPromise = Promise.resolve(mailer);
}

/** Drop the singleton so the next `getMailer()` rebuilds it from the environment. */
export function resetMailer() {
  mailerPromise = null;
}
