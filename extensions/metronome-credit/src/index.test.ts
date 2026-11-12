import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withEndpointFetchMock } from '@stripe/extensibility-test-helpers/endpoint-fetch';
import type { Context } from '@stripe/extensibility-sdk';

import { createCreditForInvoice } from './action.js';
import { ActionError, classifyMetronomeError } from './errors.js';
import type { HttpClient } from './http.js';
import CreateMetronomeCreditExtension from './index.js';
import { buildCustomerCreditRequest, uniquenessKey } from './metronome.js';
import { floorToUtcHour, toRfc3339 } from './time.js';
import { validateInput, type CreditInput } from './validation.js';

const ENDPOINT = 'metronome_api';
const PATH = '/v1/contracts/customerCredits/create';
const FAKE_TOKEN = 'mtok_live_DO_NOT_LEAK_0123456789abcdef';

// 2026-11-05T20:45:20Z -> 2026-12-05T20:45:20Z, the shape of a real subscription line period.
const validInput = (): Record<string, unknown> => ({
  stripe_invoice_id: 'in_1TestInvoice',
  stripe_customer_id: 'cus_TestCustomer',
  stripe_subscription_id: 'sub_TestSubscription',
  metronome_customer_id: 'd0034e93-5369-4e9f-ba11-34af3c59f27e',
  credit_amount: '1000',
  credit_type_id: '2714e483-4ff1-48e4-9e25-ac732e8f24f2',
  credit_product_id: 'd72716a4-1dcc-4e91-8ad4-a1be29c917a7',
  credit_priority: '100',
  credit_access_type: 'SPEND',
  starting_at: '1793911520',
  ending_before: '1796503520',
  stripe_livemode: 'false',
  invoice_amount_paid: '2000',
  invoice_currency: 'usd',
  invoice_billing_reason: 'subscription_create',
  invoice_paid_out_of_band: 'false',
});

const testContext = { type: 'test', id: 'run_1', livemode: false } as Context;

function validated(overrides: Record<string, unknown> = {}): CreditInput {
  const result = validateInput({ ...validInput(), ...overrides }, { livemode: false });
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.input;
}

function problemsFor(overrides: Record<string, unknown>, livemode = false): string[] {
  const result = validateInput({ ...validInput(), ...overrides }, { livemode });
  return result.ok ? [] : result.problems;
}

async function runWithStatus(
  status: number,
  body = '{"message":"upstream"}'
): Promise<unknown> {
  let outcome: unknown;
  await withEndpointFetchMock(
    [
      {
        request: { endpoint: ENDPOINT, method: 'POST', path: PATH },
        response: { status, body },
      },
    ],
    async () => {
      try {
        outcome = await new CreateMetronomeCreditExtension().execute(
          { customInput: validInput() },
          {},
          testContext
        );
      } catch (error) {
        outcome = error;
      }
    }
  );
  return outcome;
}

describe('request construction', () => {
  it('builds the Metronome customer credit request from valid input', () => {
    expect(buildCustomerCreditRequest(validated())).toEqual({
      customer_id: 'd0034e93-5369-4e9f-ba11-34af3c59f27e',
      access_schedule: {
        credit_type_id: '2714e483-4ff1-48e4-9e25-ac732e8f24f2',
        access_type: 'SPEND',
        schedule_items: [
          {
            amount: 1000,
            starting_at: '2026-11-05T20:00:00.000Z',
            ending_before: '2026-12-05T20:00:00.000Z',
          },
        ],
      },
      priority: 100,
      product_id: 'd72716a4-1dcc-4e91-8ad4-a1be29c917a7',
      name: 'Stripe subscription credit',
      description: 'Credit created after Stripe invoice in_1TestInvoice was paid',
      uniqueness_key: 'stripe:invoice.paid:in_1TestInvoice',
      custom_fields: {
        stripe_invoice_id: 'in_1TestInvoice',
        stripe_customer_id: 'cus_TestCustomer',
        stripe_subscription_id: 'sub_TestSubscription',
      },
    });
  });

  it('defaults priority to 100 and access type to SPEND', () => {
    const input = validated({ credit_priority: '', credit_access_type: undefined });
    expect(input.creditPriority).toBe(100);
    expect(input.creditAccessType).toBe('SPEND');
  });

  it('accepts typed numbers/booleans and QUANTITY access type', () => {
    const input = validated({
      credit_amount: 5,
      credit_priority: 0,
      stripe_livemode: false,
      invoice_paid_out_of_band: false,
      credit_access_type: 'quantity',
    });
    expect(input).toMatchObject({
      creditAmount: 5,
      creditPriority: 0,
      creditAccessType: 'QUANTITY',
    });
  });

  it('sends the request through endpointFetch without any Authorization header', async () => {
    await withEndpointFetchMock(
      [
        {
          request: {
            endpoint: ENDPOINT,
            method: 'POST',
            path: PATH,
            headers: { authorization: { absent: true } },
            bodyParameters: {
              customer_id: 'd0034e93-5369-4e9f-ba11-34af3c59f27e',
              uniqueness_key: 'stripe:invoice.paid:in_1TestInvoice',
              priority: '100',
            },
          },
          response: {
            status: 200,
            body: JSON.stringify({ data: { id: 'credit-uuid-1' } }),
          },
        },
      ],
      async () => {
        const response = await new CreateMetronomeCreditExtension().execute(
          { customInput: validInput() },
          {},
          testContext
        );
        expect(response).toEqual({
          result: 'customOutput',
          customOutput: {
            status: 'created',
            metronome_credit_id: 'credit-uuid-1',
            uniqueness_key: 'stripe:invoice.paid:in_1TestInvoice',
            stripe_invoice_id: 'in_1TestInvoice',
          },
        });
      }
    );
  });
});

describe('timestamps', () => {
  it('converts Unix seconds (number or string) to RFC 3339', () => {
    expect(toRfc3339(1704067200)).toEqual({
      ok: true,
      value: '2024-01-01T00:00:00.000Z',
      epochMs: 1704067200000,
    });
    expect(toRfc3339('1704067200')).toMatchObject({
      ok: true,
      value: '2024-01-01T00:00:00.000Z',
    });
  });

  it('normalises RFC 3339 strings with offsets to UTC', () => {
    expect(toRfc3339('2024-01-01T05:00:00+05:00')).toMatchObject({
      ok: true,
      value: '2024-01-01T00:00:00.000Z',
    });
  });

  it('rejects malformed timestamps', () => {
    for (const bad of [
      '2024-01-01',
      'yesterday',
      '-5',
      1.5,
      null,
      '2024-13-45T99:00:00Z',
    ]) {
      expect(toRfc3339(bad).ok).toBe(false);
    }
  });

  it('floors to the UTC hour for Metronome', () => {
    expect(floorToUtcHour(Date.parse('2026-11-05T20:45:20Z')).value).toBe(
      '2026-11-05T20:00:00.000Z'
    );
  });
});

describe('validation', () => {
  it('requires the Metronome customer ID', () => {
    expect(problemsFor({ metronome_customer_id: '' })).toContain(
      'metronome_customer_id is required'
    );
    expect(problemsFor({ metronome_customer_id: 'not-a-uuid' })).toContain(
      'metronome_customer_id must be a UUID'
    );
  });

  it('requires the credit type and product IDs', () => {
    const problems = problemsFor({ credit_type_id: undefined, credit_product_id: '  ' });
    expect(problems).toContain('credit_type_id is required');
    expect(problems).toContain('credit_product_id is required');
  });

  it.each(['0', '-5', 0, '1.5', 'ten'])('rejects credit_amount %j', (amount) => {
    expect(
      problemsFor({ credit_amount: amount }).some((p) => p.startsWith('credit_amount'))
    ).toBe(true);
  });

  it('rejects a negative priority and unknown access type', () => {
    expect(problemsFor({ credit_priority: '-1' })).toContain(
      'credit_priority must be a non-negative integer'
    );
    expect(problemsFor({ credit_access_type: 'FREE' })).toContain(
      'credit_access_type must be SPEND or QUANTITY'
    );
  });

  it.each([
    ['equal', '1793911520', '1793911520'],
    ['reversed', '1796503520', '1793911520'],
    ['same hour after flooring', '1793911520', '1793912000'],
  ])('rejects an invalid schedule (%s)', (_label, start, end) => {
    expect(problemsFor({ starting_at: start, ending_before: end })).toContain(
      'ending_before must be at least one UTC hour boundary after starting_at'
    );
  });

  it('rejects live-mode input and live-mode runtime context', () => {
    expect(problemsFor({ stripe_livemode: 'true' })).toContain(
      'live-mode invoices are not supported by this POC'
    );
    expect(problemsFor({}, true)).toContain(
      'live-mode invoices are not supported by this POC'
    );
  });

  it('rejects invoices paid out of band', () => {
    expect(problemsFor({ invoice_paid_out_of_band: 'true' })).toContain(
      'invoices paid out of band are not eligible for credits'
    );
  });

  it.each(['manual', 'subscription_update', 'subscription_threshold'])(
    'rejects billing reason %s',
    (reason) => {
      expect(
        problemsFor({ invoice_billing_reason: reason }).some((p) =>
          p.includes('is not supported')
        )
      ).toBe(true);
    }
  );

  it('accepts formatted invoice amounts', () => {
    for (const formatted of ['20.00', '$20.00', '2,000', 2000]) {
      expect(problemsFor({ invoice_amount_paid: formatted })).toEqual([]);
    }
    expect(problemsFor({ invoice_amount_paid: 'twenty' })).toContain(
      'invoice_amount_paid must be a number'
    );
  });

  it('rejects zero-amount invoices and bad Stripe IDs', () => {
    expect(problemsFor({ invoice_amount_paid: '0' })).toContain(
      'invoice_amount_paid must be greater than 0'
    );
    expect(problemsFor({ invoice_amount_paid: '$0.00' })).toContain(
      'invoice_amount_paid must be greater than 0'
    );
    expect(problemsFor({ stripe_subscription_id: 'in_wrong' })).toContain(
      'stripe_subscription_id must be a Stripe ID starting with sub_'
    );
  });

  it('fails execute with a non-retryable invalid_input error naming the invoice and key', async () => {
    const error = await createCreditForInvoice(
      { ...validInput(), credit_amount: '0' },
      { livemode: false },
      () => Promise.reject(new Error('should not be called'))
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect((error as Error).message).toContain('in_1TestInvoice');
    expect((error as Error).message).toContain('stripe:invoice.paid:in_1TestInvoice');
  });
});

describe('Script runtime compatibility', () => {
  it('constructs ActionError when Error.prototype.name is read-only, as in the Stripe runtime', () => {
    const original = Object.getOwnPropertyDescriptor(Error.prototype, 'name');
    Object.defineProperty(Error.prototype, 'name', { ...original, writable: false });
    try {
      const error = new ActionError('invalid_input', 'bad input');
      expect(error).toMatchObject({
        code: 'invalid_input',
        retryable: false,
        message: 'bad input',
      });
    } finally {
      if (original) Object.defineProperty(Error.prototype, 'name', original);
    }
  });
});

describe('Metronome response classification', () => {
  it('treats 409 Conflict as an idempotent success', async () => {
    const response = await runWithStatus(
      409,
      '{"message":"uniqueness key already used"}'
    );
    expect(response).toEqual({
      result: 'customOutput',
      customOutput: {
        status: 'already_exists',
        metronome_credit_id: '',
        uniqueness_key: 'stripe:invoice.paid:in_1TestInvoice',
        stripe_invoice_id: 'in_1TestInvoice',
      },
    });
  });

  it('classifies 429 as retryable', async () => {
    expect(await runWithStatus(429)).toMatchObject({
      code: 'metronome_rate_limited',
      retryable: true,
    });
  });

  it.each([500, 502, 503, 504])('classifies %i as retryable', async (status) => {
    expect(await runWithStatus(status)).toMatchObject({
      code: 'metronome_unavailable',
      retryable: true,
    });
  });

  it.each([401, 403])(
    'classifies %i as a permanent configuration failure',
    async (status) => {
      expect(await runWithStatus(status)).toMatchObject({
        code: 'metronome_auth_failed',
        retryable: false,
      });
    }
  );

  it('classifies other 4xx as permanent and surfaces only the safe upstream message', async () => {
    const error = await runWithStatus(
      400,
      '{"message":"Invalid custom field keys","extra":"ignored"}'
    );
    expect(error).toMatchObject({ code: 'metronome_request_rejected', retryable: false });
    expect((error as Error).message).toContain('Invalid custom field keys');
    expect((error as Error).message).not.toContain('ignored');
    expect((error as Error).message).toContain('stripe:invoice.paid:in_1TestInvoice');
  });

  it('classifies network failures and timeouts as retryable', async () => {
    for (const code of ['ERR_NETWORK', 'EXT_TIMEOUT', 'ERR_INTERNAL']) {
      const failing: HttpClient = () =>
        Promise.reject(Object.assign(new Error('endpointFetch failed'), { code }));
      const error = await createCreditForInvoice(
        validInput(),
        { livemode: false },
        failing
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'metronome_unavailable', retryable: true });
    }
  });

  it('classifies endpoint misconfiguration as permanent', () => {
    expect(classifyMetronomeError({ code: 'ERR_CONFIG' })).toMatchObject({
      kind: 'permanent',
      code: 'metronome_auth_failed',
    });
  });
});

describe('secret hygiene', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never includes the token in requests, outputs, errors, or logs', async () => {
    const seen: string[] = [];
    const statuses = [200, 400, 401, 403, 409, 429, 500];
    for (const status of statuses) {
      const echoing: HttpClient = (request) => {
        seen.push(JSON.stringify(request));
        // Simulate an upstream that echoes the auth header back in its error message.
        const body = JSON.stringify({
          message: `bad request, Authorization: Bearer ${FAKE_TOKEN}`,
        });
        return status === 200
          ? Promise.resolve({ status, body: '{"data":{"id":"credit-uuid"}}' })
          : Promise.reject(
              Object.assign(new Error('endpointFetch failed'), { status, body })
            );
      };
      const outcome = await createCreditForInvoice(
        validInput(),
        { livemode: false },
        echoing
      ).catch((e: unknown) => e);
      seen.push(outcome instanceof Error ? outcome.message : JSON.stringify(outcome));
    }
    const everything = [...seen, ...logged].join('\n');
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).toContain('Bearer [redacted]');
  });
});

describe('idempotency key', () => {
  it('is stable across retries for the same invoice', () => {
    const first = buildCustomerCreditRequest(validated()).uniqueness_key;
    const retry = buildCustomerCreditRequest(
      validated({ credit_amount: '1000' })
    ).uniqueness_key;
    expect(first).toBe('stripe:invoice.paid:in_1TestInvoice');
    expect(retry).toBe(first);
  });

  it('differs between invoices', () => {
    expect(uniquenessKey('in_A')).not.toBe(uniquenessKey('in_B'));
    expect(
      buildCustomerCreditRequest(validated({ stripe_invoice_id: 'in_Other' }))
        .uniqueness_key
    ).toBe('stripe:invoice.paid:in_Other');
  });
});

describe('getFormState', () => {
  it('returns a static form state echoing current values', () => {
    const state = new CreateMetronomeCreditExtension().getFormState(
      { values: { credit_amount: '5' } },
      {},
      testContext
    );
    expect(state).toEqual({ values: { credit_amount: '5' }, config: {} });
  });
});
