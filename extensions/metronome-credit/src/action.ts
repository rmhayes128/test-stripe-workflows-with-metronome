import { ActionError, classifyMetronomeError } from './errors.js';
import type { HttpClient } from './http.js';
import {
  buildCustomerCreditRequest,
  CREATE_CUSTOMER_CREDIT_PATH,
  parseCreatedCreditId,
  uniquenessKey,
} from './metronome.js';
import { validateInput } from './validation.js';

export interface CreditResult {
  status: 'created' | 'already_exists';
  metronome_credit_id: string;
  uniqueness_key: string;
  stripe_invoice_id: string;
}

/**
 * Idempotent: the uniqueness key is derived only from the invoice ID, so
 * Workflow retries and duplicate `invoice.paid` deliveries hit Metronome's
 * 409 instead of creating a second credit.
 */
export async function createCreditForInvoice(
  customInput: unknown,
  context: { livemode: boolean },
  http: HttpClient
): Promise<CreditResult> {
  const validation = validateInput(customInput, context);
  if (!validation.ok) {
    const scope = validation.invoiceId
      ? `invoice ${validation.invoiceId} (uniqueness_key ${uniquenessKey(validation.invoiceId)})`
      : 'unknown invoice';
    throw new ActionError(
      'invalid_input',
      `Invalid input for ${scope}: ${validation.problems.join('; ')}`
    );
  }

  const { input } = validation;
  const request = buildCustomerCreditRequest(input);
  const diagnostics = `invoice ${input.stripeInvoiceId}, uniqueness_key ${request.uniqueness_key}`;

  try {
    const response = await http({
      method: 'POST',
      path: CREATE_CUSTOMER_CREDIT_PATH,
      body: JSON.stringify(request),
    });
    return {
      status: 'created',
      metronome_credit_id: parseCreatedCreditId(response.body) ?? '',
      uniqueness_key: request.uniqueness_key,
      stripe_invoice_id: input.stripeInvoiceId,
    };
  } catch (error) {
    const classification = classifyMetronomeError(error);
    if (classification.kind === 'already_exists') {
      return {
        status: 'already_exists',
        metronome_credit_id: '',
        uniqueness_key: request.uniqueness_key,
        stripe_invoice_id: input.stripeInvoiceId,
      };
    }
    throw new ActionError(
      classification.code,
      `${classification.detail} (${diagnostics})`
    );
  }
}
