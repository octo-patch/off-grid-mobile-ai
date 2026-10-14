import {
  PUBLIC_HTTP_REMOTE_ERROR,
  canReconcileCredentialedEndpoint,
  isCredentialTransportDowngrade,
  remoteAuthorizationHeaders,
  validateRemoteEndpoint,
} from '../../../src/services/remoteTransportPolicy';

describe('remote transport policy', () => {
  it('sends the saved key on private-LAN and Tailscale HTTP, where Desktop serves its gateway', () => {
    for (const endpoint of [
      'http://192.168.1.30:7878',
      'http://desktop.local:7878',
      'http://desktop:7878',
      'http://100.101.102.103:7878',
    ]) {
      expect(remoteAuthorizationHeaders(endpoint, 'secret')).toEqual({
        Authorization: 'Bearer secret',
      });
    }
  });

  it('sends nothing when no key is saved', () => {
    expect(remoteAuthorizationHeaders('http://192.168.1.30:7878')).toEqual({});
    expect(remoteAuthorizationHeaders('http://192.168.1.30:7878', '')).toEqual({});
  });

  it('never sends a key to a public cleartext endpoint', () => {
    expect(() =>
      remoteAuthorizationHeaders('http://example.test:7878', 'secret'),
    ).toThrow(PUBLIC_HTTP_REMOTE_ERROR);
  });

  it('sends bearer credentials on HTTPS', () => {
    expect(
      remoteAuthorizationHeaders('https://desktop.example.test', 'secret'),
    ).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('rejects public cleartext endpoints before a request starts', () => {
    expect(() => validateRemoteEndpoint('http://example.test:7878')).toThrow(
      PUBLIC_HTTP_REMOTE_ERROR,
    );
    expect(() =>
      validateRemoteEndpoint('http://192.168.attacker.example:7878'),
    ).toThrow(PUBLIC_HTTP_REMOTE_ERROR);
    expect(() =>
      validateRemoteEndpoint('http://10.attacker.example:7878'),
    ).toThrow(PUBLIC_HTTP_REMOTE_ERROR);
  });

  it('does not reconcile a credentialed server onto a discovered HTTP endpoint', () => {
    expect(
      canReconcileCredentialedEndpoint('http://192.168.1.31:7878', true),
    ).toBe(false);
    expect(
      canReconcileCredentialedEndpoint('http://192.168.1.31:7878', false),
    ).toBe(true);
    expect(
      canReconcileCredentialedEndpoint('https://desktop.local:7878', true),
    ).toBe(true);
  });

  it('detects an HTTPS-to-HTTP response downgrade only for credentialed requests', () => {
    expect(
      isCredentialTransportDowngrade(
        'https://desktop.example.test/v1/chat',
        'http://192.168.1.30:7878/v1/chat',
        true,
      ),
    ).toBe(true);
    expect(
      isCredentialTransportDowngrade(
        'https://desktop.example.test/v1/chat',
        'http://192.168.1.30:7878/v1/chat',
        false,
      ),
    ).toBe(false);
  });
});
