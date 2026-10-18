/** MiniMax remote provider presets.
 *
 * MiniMax exposes OpenAI-compatible and Anthropic-compatible transports in
 * separate regional endpoints. Keeping the endpoints and model defaults in a
 * single registry lets callers present a provider choice without duplicating
 * routing facts throughout the remote-server UI.
 */
export const MINIMAX_PROVIDER = 'MiniMax' as const;

export const MINIMAX_ENDPOINTS = {
  global: {
    openai: 'https://api.minimax.io/v1',
    anthropic: 'https://api.minimax.io/anthropic',
  },
  china: {
    openai: 'https://api.minimaxi.com/v1',
    anthropic: 'https://api.minimaxi.com/anthropic',
  },
} as const;

export const MINIMAX_MODELS = [
  { id: 'MiniMax-M3', contextWindow: 1_000_000 },
  { id: 'MiniMax-M2.7', contextWindow: 204_800 },
] as const;

export const MINIMAX_DEFAULT_MODEL = MINIMAX_MODELS[0].id;

export type MiniMaxRegion = keyof typeof MINIMAX_ENDPOINTS;

export function isMiniMaxEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.hostname === 'api.minimax.io' || url.hostname === 'api.minimaxi.com';
  } catch {
    return false;
  }
}

export function miniMaxRegion(endpoint: string): MiniMaxRegion | null {
  try {
    const hostname = new URL(endpoint).hostname;
    if (hostname === 'api.minimax.io') return 'global';
    if (hostname === 'api.minimaxi.com') return 'china';
  } catch {
    // Invalid endpoints are handled by the editor's URL validation.
  }
  return null;
}
