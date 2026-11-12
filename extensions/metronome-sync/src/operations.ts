import { ActionError } from './errors.js';
import type { HttpClient } from './http.js';
import { parseInput } from './inputs.js';
import type { ContractInput, CreditInput, CustomerInput } from './inputs.js';
import {
  addContractCredit,
  carryoverAmount,
  creditKey,
  ensureContract,
  ensureCustomer,
  previousContract,
} from './metronome.js';

export interface SyncOutput {
  /** customer: created | existing. contract: created | transitioned | unchanged. credit: created | already_exists | skipped. */
  status: string;
  metronome_customer_id: string;
  metronome_contract_id: string;
  metronome_credit_id: string;
  /** Cents, as strings so they can be written straight into Stripe metadata. */
  credit_amount: string;
  carryover_amount: string;
  detail: string;
}

export async function runOperation(
  customInput: unknown,
  context: { livemode: boolean },
  http: HttpClient
): Promise<SyncOutput> {
  const parsed = parseInput(customInput, context);
  if (!parsed.ok) {
    throw new ActionError(
      'invalid_input',
      `Invalid input: ${parsed.problems.join('; ')}`
    );
  }
  const { input } = parsed;
  switch (input.operation) {
    case 'sync_customer':
      return syncCustomer(input, http);
    case 'sync_contract':
      return syncContract(input, http);
    case 'credit_invoice':
      return creditInvoice(input, http);
  }
}

async function syncCustomer(input: CustomerInput, http: HttpClient): Promise<SyncOutput> {
  const customer = await ensureCustomer(http, input.stripeCustomerId, input.customerName);
  return output({
    status: customer.created ? 'created' : 'existing',
    metronome_customer_id: customer.id,
    detail: `Metronome customer for ${input.stripeCustomerId} with Stripe as billing provider`,
  });
}

async function syncContract(input: ContractInput, http: HttpClient): Promise<SyncOutput> {
  const customer = await ensureCustomer(http, input.stripeCustomerId, undefined);
  const sync = await ensureContract(http, {
    customerId: customer.id,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    effectiveAtMs: input.effectiveAtMs,
  });
  return output({
    status: sync.status,
    metronome_customer_id: customer.id,
    metronome_contract_id: sync.contract.id,
    detail: `Contract for ${input.stripePriceId} starting ${sync.contract.starting_at}`,
  });
}

/**
 * The paid invoice says which plan the customer is on for this period, so it
 * also drives plan changes: an upgrade's prorated invoice (subscription_update)
 * moves the contract now, and a downgrade lands with the first invoice of the
 * period it was scheduled for. Invoice periods follow test clocks; event
 * timestamps don't.
 */
async function creditInvoice(input: CreditInput, http: HttpClient): Promise<SyncOutput> {
  const customer = await ensureCustomer(http, input.stripeCustomerId, undefined);
  const sync = await ensureContract(http, {
    customerId: customer.id,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    effectiveAtMs: input.periodStartMs,
  });
  const contractStartMs = Date.parse(sync.contract.starting_at);
  const startMs = Math.max(input.periodStartMs, contractStartMs);
  const base = {
    metronome_customer_id: customer.id,
    metronome_contract_id: sync.contract.id,
  };
  if (startMs >= input.periodEndMs) {
    return output({
      ...base,
      status: 'skipped',
      detail: 'The credit window is shorter than one hour after rounding to the hour',
    });
  }

  const carryover =
    input.billingReason === 'subscription_update'
      ? carryoverAmount({
          previous: previousContract(sync.contracts, sync.contract),
          newStartMs: contractStartMs,
          periodEndMs: input.periodEndMs,
        })
      : 0;
  const amount = input.amountPaid + carryover;
  if (amount <= 0) {
    return output({
      ...base,
      status: 'skipped',
      detail: 'Nothing to credit (amount paid is 0)',
    });
  }

  const credit = await addContractCredit(http, {
    customerId: customer.id,
    contractId: sync.contract.id,
    uniquenessKey: creditKey(input.stripeInvoiceId),
    productId: input.creditProductId,
    creditTypeId: input.creditTypeId,
    amount,
    startingAtMs: startMs,
    endingBeforeMs: input.periodEndMs,
    description:
      carryover > 0
        ? `Stripe invoice ${input.stripeInvoiceId} (${input.billingReason}): ${String(input.amountPaid)} paid + ${String(carryover)} carried over from the previous plan`
        : `Stripe invoice ${input.stripeInvoiceId} (${input.billingReason})`,
    customFields: {
      stripe_invoice_id: input.stripeInvoiceId,
      stripe_customer_id: input.stripeCustomerId,
      stripe_subscription_id: input.stripeSubscriptionId,
    },
  });
  return output({
    ...base,
    status: credit.status,
    metronome_credit_id: credit.creditId,
    credit_amount: String(amount),
    carryover_amount: String(carryover),
    detail: `Contract ${sync.status}; credit ${credit.status} for ${new Date(startMs).toISOString()} to ${new Date(input.periodEndMs).toISOString()}`,
  });
}

function output(fields: Partial<SyncOutput> & { status: string }): SyncOutput {
  return {
    metronome_customer_id: '',
    metronome_contract_id: '',
    metronome_credit_id: '',
    credit_amount: '',
    carryover_amount: '',
    detail: '',
    ...fields,
  };
}
