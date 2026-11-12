import { floorToUtcHour, toRfc3339 } from './time.js';

export type Operation = 'sync_customer' | 'sync_contract' | 'credit_invoice';
export type CreditBillingReason =
  'subscription_create' | 'subscription_cycle' | 'subscription_update';

export const USD_CENTS_CREDIT_TYPE_ID = '2714e483-4ff1-48e4-9e25-ac732e8f24f2';

export interface CustomerInput {
  operation: 'sync_customer';
  stripeCustomerId: string;
  customerName?: string;
}

export interface ContractInput {
  operation: 'sync_contract';
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  /** Floored to the UTC hour. */
  effectiveAtMs: number;
}

export interface CreditInput {
  operation: 'credit_invoice';
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  stripeInvoiceId: string;
  billingReason: CreditBillingReason;
  /** Smallest currency unit (cents). */
  amountPaid: number;
  creditProductId: string;
  creditTypeId: string;
  /** Floored to the UTC hour. */
  periodStartMs: number;
  /** Floored to the UTC hour. */
  periodEndMs: number;
}

export type ParsedInput = CustomerInput | ContractInput | CreditInput;

export type ParseResult =
  { ok: true; input: ParsedInput } | { ok: false; problems: string[] };

/**
 * Workflow fields arrive as template-rendered strings. Every problem is
 * collected so one failed run reports everything that needs fixing.
 */
export function parseInput(raw: unknown, context: { livemode: boolean }): ParseResult {
  const fields = isRecord(raw) ? raw : {};
  const problems: string[] = [];

  if (context.livemode || text(fields, 'stripe_livemode')?.toLowerCase() === 'true') {
    problems.push('live mode is not supported by this POC');
  }
  const operation = parseOperation(fields, problems);
  const stripeCustomerId = stripeId(fields, 'stripe_customer_id', 'cus_', problems);

  if (operation === 'sync_customer') {
    return finish(problems, {
      operation,
      stripeCustomerId: stripeCustomerId ?? '',
      customerName: text(fields, 'customer_name'),
    });
  }

  if (operation === 'sync_contract') {
    const stripeSubscriptionId = stripeId(
      fields,
      'stripe_subscription_id',
      'sub_',
      problems
    );
    const stripePriceId = stripeId(fields, 'stripe_price_id', 'price_', problems);
    const effectiveAt = timestamp(fields, 'subscription_start', problems);
    return finish(problems, {
      operation,
      stripeCustomerId: stripeCustomerId ?? '',
      stripeSubscriptionId: stripeSubscriptionId ?? '',
      stripePriceId: stripePriceId ?? '',
      effectiveAtMs: effectiveAt ?? 0,
    });
  }

  if (operation === 'credit_invoice') {
    const stripeSubscriptionId = stripeId(
      fields,
      'stripe_subscription_id',
      'sub_',
      problems
    );
    const stripePriceId = stripeId(fields, 'stripe_price_id', 'price_', problems);
    const stripeInvoiceId = stripeId(fields, 'stripe_invoice_id', 'in_', problems);
    const billingReason = parseBillingReason(fields, problems);
    const amountPaid = cents(fields, 'invoice_amount_paid', problems);
    const creditProductId = uuid(fields, 'credit_product_id', problems);
    const creditTypeId =
      text(fields, 'credit_type_id') === undefined
        ? USD_CENTS_CREDIT_TYPE_ID
        : uuid(fields, 'credit_type_id', problems);
    const periodStart = timestamp(fields, 'period_start', problems);
    const periodEnd = timestamp(fields, 'period_end', problems);
    if (
      periodStart !== undefined &&
      periodEnd !== undefined &&
      periodEnd <= periodStart
    ) {
      problems.push(
        'period_end must be at least one UTC hour boundary after period_start'
      );
    }
    return finish(problems, {
      operation,
      stripeCustomerId: stripeCustomerId ?? '',
      stripeSubscriptionId: stripeSubscriptionId ?? '',
      stripePriceId: stripePriceId ?? '',
      stripeInvoiceId: stripeInvoiceId ?? '',
      billingReason: billingReason ?? 'subscription_create',
      amountPaid: amountPaid ?? 0,
      creditProductId: creditProductId ?? '',
      creditTypeId: creditTypeId ?? USD_CENTS_CREDIT_TYPE_ID,
      periodStartMs: periodStart ?? 0,
      periodEndMs: periodEnd ?? 0,
    });
  }

  return { ok: false, problems };
}

function finish(problems: string[], input: ParsedInput): ParseResult {
  return problems.length > 0 ? { ok: false, problems } : { ok: true, input };
}

function parseOperation(
  fields: Record<string, unknown>,
  problems: string[]
): Operation | undefined {
  const value = text(fields, 'operation');
  if (
    value === 'sync_customer' ||
    value === 'sync_contract' ||
    value === 'credit_invoice'
  ) {
    return value;
  }
  problems.push(
    value === undefined
      ? 'operation is required'
      : 'operation must be sync_customer, sync_contract, or credit_invoice'
  );
  return undefined;
}

function parseBillingReason(
  fields: Record<string, unknown>,
  problems: string[]
): CreditBillingReason | undefined {
  const value = text(fields, 'invoice_billing_reason');
  if (
    value === 'subscription_create' ||
    value === 'subscription_cycle' ||
    value === 'subscription_update'
  ) {
    return value;
  }
  problems.push(
    'invoice_billing_reason must be subscription_create, subscription_cycle, or subscription_update (add a Workflow condition to skip other invoices)'
  );
  return undefined;
}

function text(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function stripeId(
  fields: Record<string, unknown>,
  name: string,
  prefix: string,
  problems: string[]
): string | undefined {
  const value = text(fields, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
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
  const value = text(fields, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
    return undefined;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    problems.push(`${name} must be a UUID`);
    return undefined;
  }
  return value.toLowerCase();
}

/**
 * Stripe amounts are integer cents (`2000`). A value with a decimal point
 * (`20.00`, `$20.00`) is read as a formatted major-unit amount.
 */
function cents(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): number | undefined {
  const value = text(fields, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
    return undefined;
  }
  const cleaned = value.replace(/[^\d.-]/g, '');
  const parsed = cleaned === '' ? Number.NaN : Number(cleaned);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name} must be an amount in cents, e.g. 2000`);
    return undefined;
  }
  return cleaned.includes('.') ? Math.round(parsed * 100) : Math.round(parsed);
}

function timestamp(
  fields: Record<string, unknown>,
  name: string,
  problems: string[]
): number | undefined {
  const value = text(fields, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
    return undefined;
  }
  const result = toRfc3339(value);
  if (!result.ok) {
    problems.push(`${name} ${result.reason}`);
    return undefined;
  }
  return floorToUtcHour(result.epochMs).epochMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
