import { ActionError, classifyMetronomeError } from './errors.js';
import type { HttpClient } from './http.js';

const HOUR_MS = 3_600_000;

export interface ScheduleItem {
  amount: number;
  starting_at: string;
  ending_before: string;
}

export interface ContractCredit {
  id: string;
  name?: string;
  access_schedule?: { schedule_items?: ScheduleItem[] };
}

export interface Contract {
  id: string;
  starting_at: string;
  ending_before?: string | null;
  uniqueness_key?: string | null;
  archived_at?: string | null;
  transitions?: { type: string; from_contract_id: string; to_contract_id: string }[];
  credits?: ContractCredit[];
}

export type ContractSyncStatus = 'created' | 'transitioned' | 'unchanged';

export interface ContractSyncResult {
  status: ContractSyncStatus;
  contract: Contract;
  /** All of the customer's contracts, as of after the sync. */
  contracts: Contract[];
}

/** Customers are keyed by their Stripe customer ID, stored as a Metronome ingest alias. */
export async function ensureCustomer(
  http: HttpClient,
  stripeCustomerId: string,
  name: string | undefined
): Promise<{ id: string; created: boolean }> {
  const found = await call<{ data?: { id: string }[] }>(http, {
    method: 'GET',
    path: `/v1/customers?ingest_alias=${encodeURIComponent(stripeCustomerId)}`,
  });
  const existing = found.body?.data?.[0];
  if (existing) {
    return { id: existing.id, created: false };
  }
  const created = await call<{ data?: { id: string }; conflicting_id?: string }>(
    http,
    {
      method: 'POST',
      path: '/v1/customers',
      body: JSON.stringify({
        name: name ?? stripeCustomerId,
        ingest_aliases: [stripeCustomerId],
        customer_billing_provider_configurations: [
          {
            billing_provider: 'stripe',
            delivery_method: 'direct_to_billing_provider',
            configuration: {
              stripe_customer_id: stripeCustomerId,
              stripe_collection_method: 'charge_automatically',
            },
          },
        ],
      }),
    },
    { allowConflict: true }
  );
  // 409: another Workflow run created it between the lookup and the create.
  const id = created.conflict ? created.body?.conflicting_id : created.body?.data?.id;
  if (id === undefined) {
    throw new ActionError(
      'metronome_request_rejected',
      'Metronome customer create returned no ID'
    );
  }
  return { id, created: !created.conflict };
}

export async function listContracts(
  http: HttpClient,
  customerId: string
): Promise<Contract[]> {
  const response = await call<{ data?: Contract[] }>(http, {
    method: 'POST',
    path: '/v2/contracts/list',
    body: JSON.stringify({ customer_id: customerId }),
  });
  return (response.body?.data ?? []).filter((contract) => !contract.archived_at);
}

/**
 * Makes the contract active at `effectiveAtMs` the one for `stripePriceId`
 * (each package is aliased by its Stripe Price ID). A different active
 * contract is replaced with a RENEWAL transition, which ends it when the new
 * one starts. Contract uniqueness keys make retries and racing Workflow runs
 * converge on one contract.
 */
export async function ensureContract(
  http: HttpClient,
  args: {
    customerId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    effectiveAtMs: number;
  }
): Promise<ContractSyncResult> {
  const contracts = await listContracts(http, args.customerId);
  const active = activeAt(contracts, args.effectiveAtMs);
  if (active && isForPrice(active, args.stripeSubscriptionId, args.stripePriceId)) {
    return { status: 'unchanged', contract: active, contracts };
  }

  // A transition must start after the contract it replaces (e.g. an upgrade in
  // the same hour as sign-up), and contract dates must be on the hour.
  const activeStart = active ? Date.parse(active.starting_at) : undefined;
  const startMs =
    activeStart !== undefined && args.effectiveAtMs <= activeStart
      ? activeStart + HOUR_MS
      : args.effectiveAtMs;
  const uniquenessKey = contractKey(
    args.stripeSubscriptionId,
    args.stripePriceId,
    startMs
  );

  const created = await call<{ data?: { id: string } }>(
    http,
    {
      method: 'POST',
      path: '/v1/contracts/create',
      body: JSON.stringify({
        customer_id: args.customerId,
        package_alias: args.stripePriceId,
        starting_at: new Date(startMs).toISOString(),
        uniqueness_key: uniquenessKey,
        ...(active
          ? { transition: { type: 'RENEWAL', from_contract_id: active.id } }
          : {}),
      }),
    },
    { allowConflict: true }
  );

  const after = await listContracts(http, args.customerId);
  const contract = created.conflict
    ? after.find((candidate) => candidate.uniqueness_key === uniquenessKey)
    : after.find((candidate) => candidate.id === created.body?.data?.id);
  if (!contract) {
    throw new ActionError(
      'metronome_unavailable',
      `Metronome contract ${uniquenessKey} was not found after creating it`
    );
  }
  if (created.conflict) {
    return { status: 'unchanged', contract, contracts: after };
  }
  return { status: active ? 'transitioned' : 'created', contract, contracts: after };
}

export async function addContractCredit(
  http: HttpClient,
  args: {
    customerId: string;
    contractId: string;
    uniquenessKey: string;
    productId: string;
    creditTypeId: string;
    amount: number;
    startingAtMs: number;
    endingBeforeMs: number;
    description: string;
    customFields: Record<string, string>;
  }
): Promise<{ status: 'created' | 'already_exists'; creditId: string }> {
  const response = await call<{ data?: { edit?: { add_credits?: { id: string }[] } } }>(
    http,
    {
      method: 'POST',
      path: '/v2/contracts/edit',
      body: JSON.stringify({
        customer_id: args.customerId,
        contract_id: args.contractId,
        uniqueness_key: args.uniquenessKey,
        add_credits: [
          {
            product_id: args.productId,
            name: 'Stripe subscription credit',
            description: args.description,
            priority: 100,
            access_schedule: {
              credit_type_id: args.creditTypeId,
              schedule_items: [
                {
                  amount: args.amount,
                  starting_at: new Date(args.startingAtMs).toISOString(),
                  ending_before: new Date(args.endingBeforeMs).toISOString(),
                },
              ],
            },
            custom_fields: args.customFields,
          },
        ],
      }),
    },
    { allowConflict: true }
  );
  if (response.conflict) {
    return { status: 'already_exists', creditId: '' };
  }
  return {
    status: 'created',
    creditId: response.body?.data?.edit?.add_credits?.[0]?.id ?? '',
  };
}

export function contractKey(
  subscriptionId: string,
  priceId: string,
  startMs: number
): string {
  return `stripe:${subscriptionId}:${priceId}:${new Date(startMs).toISOString()}`;
}

export function creditKey(invoiceId: string): string {
  return `stripe:contract-credit:${invoiceId}`;
}

export function activeAt(contracts: Contract[], atMs: number): Contract | undefined {
  return contracts
    .filter((contract) => {
      const start = Date.parse(contract.starting_at);
      const end = contract.ending_before ? Date.parse(contract.ending_before) : Infinity;
      return start <= atMs && atMs < end;
    })
    .sort((a, b) => Date.parse(b.starting_at) - Date.parse(a.starting_at))[0];
}

function isForPrice(
  contract: Contract,
  subscriptionId: string,
  priceId: string
): boolean {
  return (contract.uniqueness_key ?? '').startsWith(
    `stripe:${subscriptionId}:${priceId}:`
  );
}

/**
 * For a mid-period plan change: the unused share of the previous contract's
 * credits for the current period, by time, so an upgrade doesn't forfeit what
 * the customer already paid for. The RENEWAL transition truncates those
 * credits to end at the new contract's start; their original end is the Stripe
 * period end, so this gives the same answer before and after truncation (and
 * therefore on retries). Not for renewals: a credit that ended naturally at the
 * period boundary looks exactly like a truncated one.
 */
export function carryoverAmount(args: {
  previous: Contract | undefined;
  newStartMs: number;
  periodEndMs: number;
}): number {
  const { previous, newStartMs, periodEndMs } = args;
  if (!previous || newStartMs >= periodEndMs) {
    return 0;
  }
  let total = 0;
  for (const credit of previous.credits ?? []) {
    for (const item of credit.access_schedule?.schedule_items ?? []) {
      const start = Date.parse(item.starting_at);
      const end = Date.parse(item.ending_before);
      if (start >= newStartMs || (end !== newStartMs && end !== periodEndMs)) {
        continue;
      }
      total += Math.round(
        (item.amount * (periodEndMs - newStartMs)) / (periodEndMs - start)
      );
    }
  }
  return total;
}

export function previousContract(
  contracts: Contract[],
  contract: Contract
): Contract | undefined {
  const fromId = contract.transitions?.find(
    (transition) => transition.to_contract_id === contract.id
  )?.from_contract_id;
  return fromId ? contracts.find((candidate) => candidate.id === fromId) : undefined;
}

/**
 * Throws a classified `ActionError` for anything but 2xx (or 409 when
 * `allowConflict`), never echoing more than Metronome's error message.
 */
async function call<T>(
  http: HttpClient,
  request: { method: 'GET' | 'POST'; path: string; body?: string },
  options: { allowConflict?: boolean } = {}
): Promise<{ conflict: boolean; body: T | undefined }> {
  try {
    const response = await http(request);
    return { conflict: false, body: parseJson<T>(response.body) };
  } catch (error) {
    const classification = classifyMetronomeError(error);
    if (classification.kind === 'already_exists') {
      if (options.allowConflict) {
        return { conflict: true, body: parseJson<T>(readBody(error)) };
      }
      throw new ActionError('metronome_request_rejected', `${request.path}: HTTP 409`);
    }
    throw new ActionError(
      classification.code,
      `${request.path}: ${classification.detail}`
    );
  }
}

function readBody(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const { body } = error as { body?: unknown };
    return typeof body === 'string' ? body : undefined;
  }
  return undefined;
}

function parseJson<T>(body: string | undefined): T | undefined {
  if (body === undefined || body === '') {
    return undefined;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
