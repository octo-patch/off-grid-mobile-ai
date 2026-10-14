/**
 * A saved API key on a private HTTP server (backlog item 1b).
 *
 * Off Grid Desktop serves its gateway as plain HTTP on the LAN, so the app sends a saved key to a
 * private-LAN or Tailscale HTTP endpoint the same way it does over HTTPS. The real endpoint check
 * and model discovery run; the remote server is the only fake, answering at the fetch boundary the
 * way a keyed gateway or llama.cpp server on the LAN would.
 */
import { testEndpoint } from '../../../src/services/httpClientUtils';
import { fetchModelsFromServer } from '../../../src/stores/remoteServerHelpers';
import type { RemoteServer } from '../../../src/types/remoteServer';

const ENDPOINT = 'http://192.168.1.40:11434';
const realFetch = globalThis.fetch;

/**
 * A LAN server. With `key` set it answers only requests carrying `Authorization: Bearer <key>`;
 * without one it is open and ignores any Authorization header.
 */
function startLanServer(key?: string): { requests: Array<{ path: string; authorization: string | null }> } {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const authorization = new Headers(init?.headers).get('Authorization');
    requests.push({ path: url.pathname, authorization });
    if (key && authorization !== `Bearer ${key}`) {
      return new Response('{"error":{"message":"A valid API key is required."}}', { status: 401 });
    }
    if (url.pathname === '/v1/models') {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { requests };
}

const server = (apiKey?: string): RemoteServer => ({
  id: 'lan-ollama',
  name: 'LAN Ollama',
  endpoint: ENDPOINT,
  apiKey,
  providerType: 'openai-compatible',
  createdAt: '2026-09-28T10:00:00.000Z',
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('a saved key on a private HTTP server', () => {
  it('connects to a keyed server by sending its saved key over LAN HTTP', async () => {
    const lan = startLanServer('saved-key');

    const result = await testEndpoint(ENDPOINT, 5000, 'saved-key');

    expect(result.success).toBe(true);
    expect(lan.requests).toEqual([{ path: '/v1/models', authorization: 'Bearer saved-key' }]);
  });

  it('reports a refused key as a rejected key', async () => {
    startLanServer('server-key');

    const result = await testEndpoint(ENDPOINT, 5000, 'wrong-key');

    expect(result).toEqual({
      success: false,
      error: 'The server rejected the API key (HTTP 401). Check the key for this server.',
      latency: expect.any(Number),
    });
  });

  it('still connects to an open server, with or without a saved key', async () => {
    startLanServer();

    await expect(testEndpoint(ENDPOINT, 5000)).resolves.toMatchObject({ success: true });
    await expect(testEndpoint(ENDPOINT, 5000, 'saved-key')).resolves.toMatchObject({ success: true });
  });

  it('discovers models from a keyed server with the saved key', async () => {
    const lan = startLanServer('saved-key');

    const models = await fetchModelsFromServer(server('saved-key'));

    expect(models.map(model => model.id)).toContain('llama3.2:3b');
    expect(lan.requests.every(request => request.authorization === 'Bearer saved-key')).toBe(true);
  });

  it('fails discovery when the key is refused instead of reporting no models', async () => {
    startLanServer('server-key');

    await expect(fetchModelsFromServer(server('wrong-key'))).rejects.toThrow();
  });
});
