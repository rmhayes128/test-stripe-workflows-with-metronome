import type { AccessType, CreditInput } from './validation.js';

export const CREATE_CUSTOMER_CREDIT_PATH = '/v1/contracts/customerCredits/create';

/** Body of Metronome `POST /v1/contracts/customerCredits/create`. */
export interface CustomerCreditRequest {
  customer_id: string;
  access_schedule: {
    credit_type_id: string;
    access_type: AccessType;
    schedule_items: Array<{ amount: number; starting_at: string; ending_before: string }>;
  };
  priority: number;
  product_id: string;
  name: string;
  description: string;
  uniqueness_key: string;
  custom_fields: Record<string, string>;
}

export function uniquenessKey(stripeInvoiceId: string): string {
  return `stripe:invoice.paid:${stripeInvoiceId}`;
}

export function buildCustomerCreditRequest(input: CreditInput): CustomerCreditRequest {
  return {
    customer_id: input.metronomeCustomerId,
    access_schedule: {
      credit_type_id: input.creditTypeId,
      access_type: input.creditAccessType,
      schedule_items: [
        {
          amount: input.creditAmount,
          starting_at: input.startingAt,
          ending_before: input.endingBefore,
        },
      ],
    },
    priority: input.creditPriority,
    product_id: input.creditProductId,
    name: 'Stripe subscription credit',
    description: `Credit created after Stripe invoice ${input.stripeInvoiceId} was paid`,
    uniqueness_key: uniquenessKey(input.stripeInvoiceId),
    // Keys must be registered in Metronome first (scripts/metronome-setup.mjs).
    custom_fields: {
      stripe_invoice_id: input.stripeInvoiceId,
      stripe_customer_id: input.stripeCustomerId,
      stripe_subscription_id: input.stripeSubscriptionId,
    },
  };
}

/** Metronome responds `{"data": {"id": "<uuid>"}}`; anything else yields undefined. */
export function parseCreatedCreditId(body: string | undefined): string | undefined {
  if (body === undefined || body === '') {
    return undefined;
  }
  try {
    const id = (JSON.parse(body) as { data?: { id?: unknown } }).data?.id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}
