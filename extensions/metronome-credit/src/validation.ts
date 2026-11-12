import { floorToUtcHour, toRfc3339 } from './time.js';

export type SupportedBillingReason = 'subscription_create' | 'subscription_cycle';
export type AccessType = 'SPEND' | 'QUANTITY';

export const DEFAULT_PRIORITY = 100;
export const DEFAULT_ACCESS_TYPE = 'SPEND';

export interface CreditInput {
  stripeInvoiceId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  metronomeCustomerId: string;
  creditAmount: number;
  creditTypeId: string;
  creditProductId: string;
  creditPriority: number;
  creditAccessType: AccessType;
  /** RFC 3339, floored to the UTC hour (Metronome requirement). */
  startingAt: string;
  /** RFC 3339, floored to the UTC hour (Metronome requirement). */
  endingBefore: string;
  invoiceAmountPaid: number;
  invoiceCurrency: string;
  invoiceBillingReason: SupportedBillingReason;
}

export type ValidationResult =
  | { ok: true; input: CreditInput }
  | { ok: false; invoiceId: string | undefined; problems: string[] };

/**
 * Workflow fields arrive as template-rendered strings, but typed values are
 * accepted too so the schema can later switch to integer/boolean fields.
 * Every problem is collected so one failed run reports everything to fix.
 */
export function validateInput(
  raw: unknown,
  context: { livemode: boolean }
): ValidationResult {
  const fields = isRecord(raw) ? raw : {};
  const problems: string[] = [];

  const stripeInvoiceId = stripeId(fields, 'stripe_invoice_id', 'in_', problems);
  const stripeCustomerId = stripeId(fields, 'stripe_customer_id', 'cus_', problems);
  const stripeSubscriptionId = stripeId(
    fields,
    'stripe_subscription_id',
    'sub_',
    problems
  );
  const metronomeCustomerId = uuid(fields, 'metronome_customer_id', problems);
  const creditTypeId = uuid(fields, 'credit_type_id', problems);
  const creditProductId = uuid(fields, 'credit_product_id', problems);

  const creditAmount = integer(fields, 'credit_amount', problems);
  if (creditAmount !== undefined && creditAmount <= 0) {
    problems.push('credit_amount must be a positive integer');
  }

  const creditPriority = optionalInteger(
    fields,
    'credit_priority',
    DEFAULT_PRIORITY,
    problems
  );
  if (creditPriority !== undefined && creditPriority < 0) {
    problems.push('credit_priority must be a non-negative integer');
  }

  const creditAccessType = accessType(fields, problems);

  const start = timestamp(fields, 'starting_at', problems);
  const end = timestamp(fields, 'ending_before', problems);
  if (start && end && end.epochMs <= start.epochMs) {
    problems.push(
      'ending_before must be at least one UTC hour boundary after starting_at'
    );
  }

  const livemode = boolean(fields, 'stripe_livemode', problems);
  if (livemode === true || context.livemode) {
    problems.push('live-mode invoices are not supported by this POC');
  }

  const invoiceAmountPaid = amount(fields, 'invoice_amount_paid', problems);
  if (invoiceAmountPaid !== undefined && invoiceAmountPaid <= 0) {
    problems.push('invoice_amount_paid must be greater than 0');
  }

  const currencyRaw = text(fields, 'invoice_currency', problems)?.toLowerCase();
  if (currencyRaw !== undefined && !/^[a-z]{3}$/.test(currencyRaw)) {
    problems.push('invoice_currency must be a three-letter ISO currency code');
  }

  const billingReason = text(fields, 'invoice_billing_reason', problems);
  if (billingReason !== undefined && !isSupportedBillingReason(billingReason)) {
    problems.push(
      `invoice_billing_reason "${billingReason}" is not supported (expected subscription_create or subscription_cycle)`
    );
  }

  const paidOutOfBand = boolean(fields, 'invoice_paid_out_of_band', problems);
  if (paidOutOfBand === true) {
    problems.push('invoices paid out of band are not eligible for credits');
  }

  if (
    problems.length > 0 ||
    stripeInvoiceId === undefined ||
    stripeCustomerId === undefined ||
    stripeSubscriptionId === undefined ||
    metronomeCustomerId === undefined ||
    creditTypeId === undefined ||
    creditProductId === undefined ||
    creditAmount === undefined ||
    creditPriority === undefined ||
    creditAccessType === undefined ||
    start === undefined ||
    end === undefined ||
    invoiceAmountPaid === undefined ||
    currencyRaw === undefined ||
    billingReason === undefined ||
    !isSupportedBillingReason(billingReason)
  ) {
    return { ok: false, invoiceId: stripeInvoiceId, problems };
  }

  return {
    ok: true,
    input: {
      stripeInvoiceId,
      stripeCustomerId,
      stripeSubscriptionId,
      metronomeCustomerId,
      creditAmount,
      creditTypeId,
      creditProductId,
      creditPriority,
      creditAccessType,
      startingAt: start.value,
      endingBefore: end.value,
      invoiceAmountPaid,
      invoiceCurrency: currencyRaw,
      invoiceBillingReason: billingReason,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedBillingReason(value: string): value is SupportedBillingReason {
  return value === 'subscription_create' || value === 'subscription_cycle';
}

function isAccessType(value: string | undefined): value is AccessType {
  return value === 'SPEND' || value === 'QUANTITY';
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function text(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): string | undefined {
  const value = fields[name];
  if (isBlank(value)) {
    problems.push(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    problems.push(`${name} must be a string`);
    return undefined;
  }
  return value.trim();
}

function stripeId(
  fields: Record<string, unknown>,
  name: string,
  prefix: string,
  problems: string[]
): string | undefined {
  const value = text(fields, name, problems);
  if (value === undefined) {
    return undefined;
  }
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(value)) {
    problems.push(`${name} must be a Stripe ID starting with ${prefix}`);
    return undefined;
  }
  return value;
}

function uuid(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): string | undefined {
  const value = text(fields, name, problems);
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    problems.push(`${name} must be a UUID`);
    return undefined;
  }
  return value.toLowerCase();
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function integer(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): number | undefined {
  const value = fields[name];
  if (isBlank(value)) {
    problems.push(`${name} is required`);
    return undefined;
  }
  const parsed = parseInteger(value);
  if (parsed === undefined) {
    problems.push(`${name} must be an integer`);
  }
  return parsed;
}

/**
 * Only used as a "greater than zero" guard, so formatted amounts the Workflow
 * builder may render (`20.00`, `$20.00`, `2,000`) are accepted alongside `2000`.
 */
function amount(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): number | undefined {
  const value = fields[name];
  if (isBlank(value)) {
    problems.push(`${name} is required`);
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const cleaned = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : '';
  const parsed = cleaned === '' ? Number.NaN : Number(cleaned);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name} must be a number`);
    return undefined;
  }
  return parsed;
}

function optionalInteger(
  fields: Record<string, unknown>,
  name: string,
  fallback: number,
  problems: string[]
): number | undefined {
  return isBlank(fields[name]) ? fallback : integer(fields, name, problems);
}

function boolean(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): boolean | undefined {
  const value = fields[name];
  if (typeof value === 'boolean') {
    return value;
  }
  if (isBlank(value)) {
    problems.push(`${name} is required`);
    return undefined;
  }
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  problems.push(`${name} must be true or false`);
  return undefined;
}

function accessType(
  fields: Record<string, unknown>,
  problems: string[]
): AccessType | undefined {
  const value = fields['credit_access_type'];
  if (isBlank(value)) {
    return DEFAULT_ACCESS_TYPE;
  }
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  if (!isAccessType(normalized)) {
    problems.push('credit_access_type must be SPEND or QUANTITY');
    return undefined;
  }
  return normalized;
}

function timestamp(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): { value: string; epochMs: number } | undefined {
  const value = fields[name];
  if (isBlank(value)) {
    problems.push(`${name} is required`);
    return undefined;
  }
  const result = toRfc3339(value);
  if (!result.ok) {
    problems.push(`${name} ${result.reason}`);
    return undefined;
  }
  return floorToUtcHour(result.epochMs);
}
