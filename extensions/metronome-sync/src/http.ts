/** Must match the endpoint `id` in stripe-app.yaml (unique across the app's extensions). */
export const METRONOME_ENDPOINT_ID = 'metronome_sync_api';

export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body?: string;
}

/**
 * Resolves for 2xx and rejects with an `EndpointFetchError`-shaped value
 * otherwise, mirroring `endpointFetch`.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * The Metronome bearer token is injected by Stripe from the Secret Store
 * (manifest `auth`), so it never passes through this code.
 */
export async function endpointFetchClient(request: HttpRequest): Promise<HttpResponse> {
  const response = await endpointFetch({
    endpoint: METRONOME_ENDPOINT_ID,
    method: request.method,
    path: request.path,
    body: request.body,
    headers: { 'Content-Type': 'application/json' },
  });
  return { status: response.status, body: response.body };
}
