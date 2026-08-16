import { describe, expect, it } from 'vitest'
import { authenticateMobileE2EE } from './mobile-e2ee-auth-validation'

const device = {
  deviceId: 'device-1',
  deviceToken: 'token-1',
  scope: 'runtime' as const
}

function authenticate(fields: Record<string, unknown>) {
  return authenticateMobileE2EE({
    plaintext: JSON.stringify({ type: 'e2ee_auth', deviceToken: device.deviceToken, ...fields }),
    v2Session: null,
    resolveDevice: (token) => (token === device.deviceToken ? device : null)
  })
}

describe('mobile E2EE channel authentication', () => {
  it('preserves legacy RPC authentication', () => {
    expect(authenticate({}).ok).toBe(true)
    expect(authenticate({ channel: 'rpc' }).ok).toBe(true)
  })

  it('requires a bounded grant for the tunnel channel', () => {
    expect(authenticate({ channel: 'workspace-port-tunnel.v1' }).ok).toBe(false)
    expect(authenticate({ channel: 'workspace-port-tunnel.v1', tunnelGrantId: '' }).ok).toBe(false)
    expect(
      authenticate({ channel: 'workspace-port-tunnel.v1', tunnelGrantId: 'x'.repeat(257) }).ok
    ).toBe(false)
    expect(authenticate({ channel: 'workspace-port-tunnel.v1', tunnelGrantId: 'grant-1' }).ok).toBe(
      true
    )
  })

  it('rejects unknown channels and grants on RPC authentication', () => {
    expect(authenticate({ channel: 'other' }).ok).toBe(false)
    expect(authenticate({ channel: 'rpc', tunnelGrantId: 'grant-1' }).ok).toBe(false)
    expect(authenticate({ tunnelGrantId: 'grant-1' }).ok).toBe(false)
  })
})
