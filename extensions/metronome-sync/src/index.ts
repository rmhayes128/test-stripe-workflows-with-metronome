// Learn more about this extension point: https://docs.stripe.com/extensions/custom-action
import type { Extend, Context } from '@stripe/extensibility-sdk';

import { endpointFetchClient } from './http.js';
import { runOperation } from './operations.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface MetronomeSyncExtensionConfig {}

/**
 * One action for three Workflows, selected by the `operation` input:
 * sync_customer (customer.created), sync_contract (customer.subscription.created),
 * and credit_invoice (invoice.paid).
 */
export default class MetronomeSyncExtension implements Extend.Workflows
  .CustomAction<MetronomeSyncExtensionConfig> {
  async execute(
    request: Extend.Workflows.CustomAction.ExecuteCustomActionRequest,
    _config: MetronomeSyncExtensionConfig,
    context: Context
  ): Promise<Extend.Workflows.CustomAction.ExecuteCustomActionResponse> {
    const result = await runOperation(
      request.customInput,
      { livemode: context.livemode },
      endpointFetchClient
    );
    return { result: 'customOutput', customOutput: { ...result } };
  }

  getFormState(
    request: Extend.Workflows.CustomAction.GetFormStateRequest,
    _config: MetronomeSyncExtensionConfig,
    _context: Context
  ): Extend.Workflows.CustomAction.GetFormStateResponse {
    return {
      values: request.values,
      config: {},
    };
  }
}
