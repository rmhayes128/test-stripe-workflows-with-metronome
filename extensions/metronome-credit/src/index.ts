// Learn more about this extension point: https://docs.stripe.com/extensions/custom-action
import type { Extend, Context } from '@stripe/extensibility-sdk';

import { createCreditForInvoice } from './action.js';
import { endpointFetchClient } from './http.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CreateMetronomeCreditExtensionConfig {}

export default class CreateMetronomeCreditExtension implements Extend.Workflows
  .CustomAction<CreateMetronomeCreditExtensionConfig> {
  async execute(
    request: Extend.Workflows.CustomAction.ExecuteCustomActionRequest,
    _config: CreateMetronomeCreditExtensionConfig,
    context: Context
  ): Promise<Extend.Workflows.CustomAction.ExecuteCustomActionResponse> {
    const result = await createCreditForInvoice(
      request.customInput,
      { livemode: context.livemode },
      endpointFetchClient
    );
    return { result: 'customOutput', customOutput: { ...result } };
  }

  // Every field is a static, template-enabled control, so no dynamic state is needed.
  getFormState(
    request: Extend.Workflows.CustomAction.GetFormStateRequest,
    _config: CreateMetronomeCreditExtensionConfig,
    _context: Context
  ): Extend.Workflows.CustomAction.GetFormStateResponse {
    return {
      values: request.values,
      config: {},
    };
  }
}
