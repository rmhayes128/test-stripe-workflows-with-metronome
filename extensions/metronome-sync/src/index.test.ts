import { describe, expect, it } from 'vitest';
import { withEndpointFetchMock } from '@stripe/extensibility-test-helpers/endpoint-fetch';
import type { Context } from '@stripe/extensibility-sdk';

import { ActionError } from './errors.js';
import type { HttpClient, HttpRequest } from './http.js';
import MetronomeSyncExtension from './index.js';
import { parseInput } from './inputs.js';
import { carryoverAmount } from './metronome.js';
import type { Contract } from './metronome.js';
import { runOperation } from './operations.js';

const CUSTOMER = 'cus_TestCustomer';
const SUB = 'sub_TestSubscription';
const GOOD = 'price_Good';
const BETTER = 'price_Better';
const PRODUCT = 'd72716a4-1dcc-4e91-8ad4-a1be29c917a7';
const testContext = { type: 'test', id: 'run_1', livemode: false } as Context;

// Sign-up at 18:44:32; Stripe periods run to the same second next month.
const SIGNUP = '2026-11-06T18:44:32Z';
const RENEWAL = '2026-12-06T18:44:32Z';
const NEXT_RENEWAL = '2027-01-06T18:44:32Z';
const hourMs = (iso: string): number => Date.parse(iso) - (Date.parse(iso) % 3_600_000);

/**
 * In-memory Metronome with the behaviour verified against the sandbox:
 * 409 on reused ingest aliases and uniqueness keys, and RENEWAL transitions
 * that end the old contract (and truncate its credits) at the new start.
 */
function fakeMetronome() {
  const customers: { id: string; alias: string }[] = [];
  const contracts: (Contract & { customer_id: string; package_alias: string })[] = [];
  const editKeys = new Set<string>();
  const requests: HttpRequest[] = [];
  let seq = 0;
  const reject = (status: number, body: Record<string, unknown>) => {
    throw Object.assign(new Error(`HTTP ${String(status)}`), {
      status,
      body: JSON.stringify(body),
    });
  };
  const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });

  const http: HttpClient = (request) => {
    requests.push(request);
    const body = request.body ? (JSON.parse(request.body) as Record<string, any>) : {};
    const [path, query] = request.path.split('?');
    if (request.method === 'GET' && path === '/v1/customers') {
      const alias = new URLSearchParams(query).get('ingest_alias');
      return Promise.resolve(ok(customers.filter((c) => c.alias === alias)));
    }
    if (path === '/v1/customers') {
      const alias = body.ingest_aliases[0] as string;
      const existing = customers.find((c) => c.alias === alias);
      if (existing) reject(409, { message: 'conflict', conflicting_id: existing.id });
      const customer = { id: `mcus-${String(++seq)}`, alias };
      customers.push(customer);
      return Promise.resolve(ok({ id: customer.id }));
    }
    if (path === '/v2/contracts/list') {
      return Promise.resolve(
        ok(contracts.filter((c) => c.customer_id === body.customer_id))
      );
    }
    if (path === '/v1/contracts/create') {
      if (contracts.some((c) => c.uniqueness_key === body.uniqueness_key)) {
        reject(409, { message: 'uniqueness_key already exists' });
      }
      const contract = {
        id: `contract-${String(++seq)}`,
        customer_id: body.customer_id,
        package_alias: body.package_alias,
        starting_at: body.starting_at,
        ending_before: null as string | null,
        uniqueness_key: body.uniqueness_key,
        transitions: [] as Contract['transitions'],
        credits: [] as Contract['credits'],
      };
      if (body.transition) {
        const from = contracts.find((c) => c.id === body.transition.from_contract_id)!;
        from.ending_before = body.starting_at;
        for (const credit of from.credits ?? []) {
          for (const item of credit.access_schedule?.schedule_items ?? []) {
            if (Date.parse(item.ending_before) > Date.parse(body.starting_at)) {
              item.ending_before = body.starting_at;
            }
          }
        }
        const transition = {
          type: 'RENEWAL',
          from_contract_id: from.id,
          to_contract_id: contract.id,
        };
        from.transitions = [...(from.transitions ?? []), transition];
        contract.transitions = [transition];
      }
      contracts.push(contract);
      return Promise.resolve(ok({ id: contract.id }));
    }
    if (path === '/v2/contracts/edit') {
      if (editKeys.has(body.uniqueness_key))
        reject(409, { message: 'Uniqueness key already exists' });
      editKeys.add(body.uniqueness_key);
      const contract = contracts.find((c) => c.id === body.contract_id)!;
      const added = (body.add_credits as any[]).map((credit) => ({
        id: `credit-${String(++seq)}`,
        name: credit.name,
        access_schedule: { schedule_items: credit.access_schedule.schedule_items },
      }));
      contract.credits = [...(contract.credits ?? []), ...added];
      return Promise.resolve(ok({ id: contract.id, edit: { add_credits: added } }));
    }
    return Promise.reject(
      Object.assign(new Error('unexpected'), { status: 404, body: '{}' })
    );
  };
  return { http, customers, contracts, requests };
}

const credit = (overrides: Record<string, unknown>) => ({
  operation: 'credit_invoice',
  stripe_customer_id: CUSTOMER,
  stripe_subscription_id: SUB,
  stripe_price_id: GOOD,
  stripe_invoice_id: 'in_First',
  invoice_billing_reason: 'subscription_create',
  invoice_amount_paid: '2000',
  period_start: SIGNUP,
  period_end: RENEWAL,
  credit_product_id: PRODUCT,
  ...overrides,
});
const contractSync = (overrides: Record<string, unknown> = {}) => ({
  operation: 'sync_contract',
  stripe_customer_id: CUSTOMER,
  stripe_subscription_id: SUB,
  stripe_price_id: GOOD,
  subscription_start: SIGNUP,
  ...overrides,
});
const run = (
  metronome: ReturnType<typeof fakeMetronome>,
  input: Record<string, unknown>
) => runOperation(input, { livemode: false }, metronome.http);
const items = (contract: Contract | undefined) =>
  (contract?.credits ?? []).flatMap((c) => c.access_schedule?.schedule_items ?? []);

describe('sign-up', () => {
  it('converges no matter which Workflow runs first, with one customer, contract, and credit', async () => {
    const m = fakeMetronome();
    const paid = await run(m, credit({}));
    const subscribed = await run(m, contractSync());
    const customer = await run(m, {
      operation: 'sync_customer',
      stripe_customer_id: CUSTOMER,
      customer_name: 'Ada',
    });

    expect(m.customers).toHaveLength(1);
    expect(m.contracts).toHaveLength(1);
    expect(paid).toMatchObject({
      status: 'created',
      credit_amount: '2000',
      carryover_amount: '0',
    });
    expect(subscribed).toMatchObject({
      status: 'unchanged',
      metronome_contract_id: paid.metronome_contract_id,
    });
    expect(customer).toMatchObject({
      status: 'existing',
      metronome_customer_id: paid.metronome_customer_id,
    });
    expect(m.contracts[0]).toMatchObject({
      package_alias: GOOD,
      starting_at: '2026-11-06T18:00:00.000Z',
    });
    expect(items(m.contracts[0])).toEqual([
      {
        amount: 2000,
        starting_at: '2026-11-06T18:00:00.000Z',
        ending_before: '2026-12-06T18:00:00.000Z',
      },
    ]);
  });

  it('creates the customer with Stripe as billing provider and the contract from the price-aliased package', async () => {
    const m = fakeMetronome();
    await run(m, contractSync());
    const createCustomer = m.requests.find(
      (r) => r.method === 'POST' && r.path === '/v1/customers'
    );
    expect(JSON.parse(createCustomer?.body ?? '{}')).toMatchObject({
      ingest_aliases: [CUSTOMER],
      customer_billing_provider_configurations: [
        {
          billing_provider: 'stripe',
          delivery_method: 'direct_to_billing_provider',
          configuration: { stripe_customer_id: CUSTOMER },
        },
      ],
    });
    const createContract = m.requests.find((r) => r.path === '/v1/contracts/create');
    expect(JSON.parse(createContract?.body ?? '{}')).toEqual({
      customer_id: 'mcus-1',
      package_alias: GOOD,
      starting_at: '2026-11-06T18:00:00.000Z',
      uniqueness_key: `stripe:${SUB}:${GOOD}:2026-11-06T18:00:00.000Z`,
    });
  });

  it('is idempotent when Stripe retries the invoice', async () => {
    const m = fakeMetronome();
    await run(m, credit({}));
    const retry = await run(m, credit({}));
    expect(retry).toMatchObject({ status: 'already_exists' });
    expect(items(m.contracts[0])).toHaveLength(1);
  });
});

describe('upgrade (prorated subscription_update invoice)', () => {
  const UPGRADE_AT = '2026-11-20T12:30:00Z';
  const upgrade = credit({
    stripe_price_id: BETTER,
    stripe_invoice_id: 'in_Upgrade',
    invoice_billing_reason: 'subscription_update',
    invoice_amount_paid: '1400',
    period_start: UPGRADE_AT,
  });

  it('transitions to Better and credits the amount paid plus the unused Good credit', async () => {
    const m = fakeMetronome();
    await run(m, credit({}));
    const result = await run(m, upgrade);

    const [good, better] = m.contracts;
    const newStart = hourMs(UPGRADE_AT);
    const expectedCarry = Math.round(
      (2000 * (hourMs(RENEWAL) - newStart)) / (hourMs(RENEWAL) - hourMs(SIGNUP))
    );
    expect(good?.ending_before).toBe('2026-11-20T12:00:00.000Z');
    expect(better).toMatchObject({
      package_alias: BETTER,
      starting_at: '2026-11-20T12:00:00.000Z',
    });
    expect(better?.transitions?.[0]).toMatchObject({
      type: 'RENEWAL',
      from_contract_id: good?.id,
    });
    expect(result).toMatchObject({
      status: 'created',
      metronome_contract_id: better?.id,
      carryover_amount: String(expectedCarry),
      credit_amount: String(1400 + expectedCarry),
    });
    expect(items(better)).toEqual([
      {
        amount: 1400 + expectedCarry,
        starting_at: '2026-11-20T12:00:00.000Z',
        ending_before: '2026-12-06T18:00:00.000Z',
      },
    ]);
  });

  it('computes the same carryover on a retry after the transition truncated the Good credit', async () => {
    const m = fakeMetronome();
    await run(m, credit({}));
    const first = await run(m, upgrade);
    const retry = await run(m, upgrade);
    expect(retry).toMatchObject({
      status: 'already_exists',
      carryover_amount: first.carryover_amount,
    });
    expect(m.contracts).toHaveLength(2);
  });

  it('starts Better at the next hour when upgrading in the same hour as sign-up', async () => {
    const m = fakeMetronome();
    await run(m, credit({}));
    const result = await run(m, { ...upgrade, period_start: '2026-11-06T18:50:00Z' });
    expect(m.contracts[1]?.starting_at).toBe('2026-11-06T19:00:00.000Z');
    expect(m.contracts[0]?.ending_before).toBe('2026-11-06T19:00:00.000Z');
    expect(result.status).toBe('created');
  });
});

describe('renewals', () => {
  it('keeps the contract and adds the next period credit on a same-plan renewal', async () => {
    const m = fakeMetronome();
    await run(m, credit({}));
    const result = await run(
      m,
      credit({
        stripe_invoice_id: 'in_Cycle',
        invoice_billing_reason: 'subscription_cycle',
        period_start: RENEWAL,
        period_end: NEXT_RENEWAL,
      })
    );
    expect(m.contracts).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'created',
      carryover_amount: '0',
      credit_amount: '2000',
    });
  });

  it('applies a downgrade scheduled for period end at renewal, without carrying over the ended period', async () => {
    const m = fakeMetronome();
    await run(m, credit({ stripe_price_id: BETTER, invoice_amount_paid: '5000' }));
    const result = await run(
      m,
      credit({
        stripe_price_id: GOOD,
        stripe_invoice_id: 'in_Downgraded',
        invoice_billing_reason: 'subscription_cycle',
        period_start: RENEWAL,
        period_end: NEXT_RENEWAL,
      })
    );
    const [better, good] = m.contracts;
    expect(better?.ending_before).toBe('2026-12-06T18:00:00.000Z');
    expect(good).toMatchObject({
      package_alias: GOOD,
      starting_at: '2026-12-06T18:00:00.000Z',
    });
    expect(result).toMatchObject({
      status: 'created',
      carryover_amount: '0',
      credit_amount: '2000',
    });
    expect(items(better)).toEqual([
      {
        amount: 5000,
        starting_at: '2026-11-06T18:00:00.000Z',
        ending_before: '2026-12-06T18:00:00.000Z',
      },
    ]);
  });
});

describe('carryoverAmount', () => {
  const previous = (item: {
    amount: number;
    starting_at: string;
    ending_before: string;
  }): Contract => ({
    id: 'c',
    starting_at: item.starting_at,
    credits: [{ id: 'x', access_schedule: { schedule_items: [item] } }],
  });
  const period = { periodEndMs: hourMs(RENEWAL) };

  it('is half the credit halfway through the period, before or after truncation', () => {
    const start = '2026-11-06T18:00:00.000Z';
    const mid = (hourMs(SIGNUP) + hourMs(RENEWAL)) / 2;
    const midIso = new Date(mid).toISOString();
    const before = previous({
      amount: 2000,
      starting_at: start,
      ending_before: '2026-12-06T18:00:00.000Z',
    });
    const after = previous({ amount: 2000, starting_at: start, ending_before: midIso });
    expect(carryoverAmount({ previous: before, newStartMs: mid, ...period })).toBe(1000);
    expect(carryoverAmount({ previous: after, newStartMs: mid, ...period })).toBe(1000);
  });

  it('is zero without a previous contract, at the period end, or for earlier periods', () => {
    expect(
      carryoverAmount({ previous: undefined, newStartMs: hourMs(SIGNUP), ...period })
    ).toBe(0);
    const current = previous({
      amount: 2000,
      starting_at: '2026-11-06T18:00:00.000Z',
      ending_before: '2026-12-06T18:00:00.000Z',
    });
    expect(
      carryoverAmount({ previous: current, newStartMs: hourMs(RENEWAL), ...period })
    ).toBe(0);
    const earlier = previous({
      amount: 2000,
      starting_at: '2026-10-06T18:00:00.000Z',
      ending_before: '2026-11-06T18:00:00.000Z',
    });
    expect(
      carryoverAmount({
        previous: earlier,
        newStartMs: Date.parse('2026-11-20T12:00:00Z'),
        ...period,
      })
    ).toBe(0);
  });
});

describe('input validation', () => {
  const problems = (input: Record<string, unknown>, livemode = false) => {
    const result = parseInput(input, { livemode });
    return result.ok ? [] : result.problems;
  };

  it('reports every missing credit_invoice field at once', () => {
    expect(
      problems({ operation: 'credit_invoice', stripe_customer_id: CUSTOMER })
    ).toEqual([
      'stripe_subscription_id is required',
      'stripe_price_id is required',
      'stripe_invoice_id is required',
      'invoice_billing_reason must be subscription_create, subscription_cycle, or subscription_update (add a Workflow condition to skip other invoices)',
      'invoice_amount_paid is required',
      'credit_product_id is required',
      'period_start is required',
      'period_end is required',
    ]);
  });

  it('rejects unknown operations, bad IDs, and live mode', () => {
    expect(problems({ operation: 'nope', stripe_customer_id: 'sub_x' })).toEqual([
      'operation must be sync_customer, sync_contract, or credit_invoice',
      'stripe_customer_id must be a Stripe ID starting with cus_',
    ]);
    expect(
      problems({ operation: 'sync_customer', stripe_customer_id: CUSTOMER }, true)
    ).toContain('live mode is not supported by this POC');
  });

  it('reads amounts as cents, or as major units when formatted with a decimal point', () => {
    const amount = (value: string) => {
      const result = parseInput(credit({ invoice_amount_paid: value }), {
        livemode: false,
      });
      return result.ok && result.input.operation === 'credit_invoice'
        ? result.input.amountPaid
        : undefined;
    };
    expect(amount('2000')).toBe(2000);
    expect(amount('20.00')).toBe(2000);
    expect(amount('$1,234.56')).toBe(123456);
  });

  it('throws a non-retryable invalid_input ActionError', async () => {
    const m = fakeMetronome();
    const error = await run(m, {
      operation: 'credit_invoice',
      stripe_customer_id: CUSTOMER,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(m.requests).toHaveLength(0);
  });
});

describe('Metronome failures', () => {
  const failing =
    (status: number): HttpClient =>
    () =>
      Promise.reject(
        Object.assign(new Error('x'), {
          status,
          body: '{"message":"nope Bearer secret123"}',
        })
      );

  it.each([
    [401, 'metronome_auth_failed', false],
    [400, 'metronome_request_rejected', false],
    [429, 'metronome_rate_limited', true],
    [503, 'metronome_unavailable', true],
  ])('maps HTTP %i to %s', async (status, code, retryable) => {
    const error = await runOperation(
      contractSync(),
      { livemode: false },
      failing(status)
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, retryable });
    expect(String((error as Error).message)).not.toContain('secret123');
  });
});

describe('extension entry point', () => {
  it('calls Metronome through endpointFetch without an Authorization header', async () => {
    await withEndpointFetchMock(
      [
        {
          request: {
            endpoint: 'metronome_sync_api',
            method: 'GET',
            path: `/v1/customers?ingest_alias=${CUSTOMER}`,
            headers: { authorization: { absent: true } },
          },
          response: {
            status: 200,
            body: JSON.stringify({ data: [{ id: 'mcus-existing' }] }),
          },
        },
      ],
      async () => {
        const response = await new MetronomeSyncExtension().execute(
          { customInput: { operation: 'sync_customer', stripe_customer_id: CUSTOMER } },
          {},
          testContext
        );
        expect(response).toEqual({
          result: 'customOutput',
          customOutput: expect.objectContaining({
            status: 'existing',
            metronome_customer_id: 'mcus-existing',
          }),
        });
      }
    );
  });
});
