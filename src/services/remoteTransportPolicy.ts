import { isTailscaleIPv4 } from '../utils/network';

export const PUBLIC_HTTP_REMOTE_ERROR =
  'Remote HTTP servers must use a private LAN or Tailscale address.';

function isPrivateHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    // Single-label names use the device's local DNS search domain. Public DNS
    // cannot resolve them without a local resolver.
    (!hostname.includes('.') && !hostname.includes(':'))
  )
    return true;

  const octets = hostname.split('.');
  if (
    octets.length !== 4 ||
    octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
  )
    return false;

  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    isTailscaleIPv4(hostname)
  );
}

/** Validate the transport before any remote request starts. */
export function validateRemoteEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isPrivateHost(url.hostname)) return url;
  throw new Error(PUBLIC_HTTP_REMOTE_ERROR);
}

/**
 * A saved key is sent to every endpoint the app accepts: HTTPS anywhere, and HTTP only on a
 * private LAN or Tailscale address (validateRemoteEndpoint rejects public cleartext). Off Grid
 * Desktop's gateway serves plain HTTP on the LAN, so a phone must send its key there for the
 * gateway's API keys to work.
 */
export function remoteAuthorizationHeaders(
  endpoint: string,
  apiKey?: string | null,
): Record<string, string> {
  validateRemoteEndpoint(endpoint);
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Automatic discovery must never carry a saved credential into cleartext. */
export function canReconcileCredentialedEndpoint(
  endpoint: string,
  hasStoredCredential: boolean,
): boolean {
  const url = validateRemoteEndpoint(endpoint);
  return !hasStoredCredential || url.protocol === 'https:';
}

/** React Native fetch must reject redirects instead of following a TLS downgrade. */
export const REMOTE_FETCH_REDIRECT_POLICY = 'error' as const;

/** Reject a credentialed response if the native client followed a TLS downgrade. */
export function isCredentialTransportDowngrade(
  requestUrl: string,
  responseUrl: string | undefined,
  hasAuthorization: boolean,
): boolean {
  if (!hasAuthorization || !responseUrl) return false;
  return (
    new URL(requestUrl).protocol === 'https:' &&
    new URL(responseUrl).protocol !== 'https:'
  );
}
