import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { WorkspacePortTunnelGrantStore } from './workspace-port-tunnel-grant-store'
import {
  decodeWorkspacePortTunnelFrame,
  encodeWorkspacePortTunnelFrame,
  encodeWorkspacePortTunnelEndpointId,
  WorkspacePortTunnelOpcode
} from '../../shared/workspace-port-tunnel-protocol'
import {
  decodeWorkspacePortTunnelAuthorizedPayload,
  decodeWorkspacePortTunnelWindowUpdatePayload,
  encodeWorkspacePortTunnelWindowUpdatePayload
} from '../../shared/workspace-port-tunnel-payloads'
import { WorkspacePortTunnelSession } from './workspace-port-tunnel-session'
import {
  createFakeSocket,
  createFakeSocketFactory
} from './workspace-port-tunnel-session-test-harness'
import {
  createNodeNetSocketFactory,
  type NetSocketFactoryTimer
} from './workspace-port-tunnel-session-sockets'

const DEVICE_TOKEN = 'device-token-test'
const RUNTIME_ID = 'runtime-test'

type SentFrame = { opcode: WorkspacePortTunnelOpcode; streamId: number; payload: Uint8Array }

type Harness = ReturnType<typeof createHarness>

function createHarness() {
  const grantStore = new WorkspacePortTunnelGrantStore()
  const socketFactory = createFakeSocketFactory()
  const sentFrames: SentFrame[] = []
  // Why: mutable holder the test flips via h.sendFrameReturn; the mock impl
  // reads this so mockReturnValue does not clobber frame recording.
  const sendReturn = { value: true }
  const sendFrame = vi.fn((bytes: Uint8Array<ArrayBufferLike>): boolean => {
    if (!sendReturn.value) {
      // Why: transport backpressure — frame not delivered, so do not record.
      return false
    }
    const d = decodeWorkspacePortTunnelFrame(bytes)
    if (d) {
      sentFrames.push({ opcode: d.opcode, streamId: d.streamId, payload: d.payload })
    }
    return true
  })
  const closeChannel = vi.fn()
  const session = new WorkspacePortTunnelSession({
    grantStore,
    deviceToken: DEVICE_TOKEN,
    runtimeInstanceId: RUNTIME_ID,
    socketFactory,
    sendFrame,
    closeChannel,
    connectTimeoutMs: 5000
  })
  return { grantStore, socketFactory, sentFrames, sendFrame, sendReturn, closeChannel, session }
}

function buildSession(h: Harness, endpointId: number, port: number): void {
  const result = h.grantStore.issue({
    deviceToken: DEVICE_TOKEN,
    deviceScope: 'runtime',
    runtimeInstanceId: RUNTIME_ID,
    resolvedWorkspace: { worktreeId: 'wt-1', runtimeInstanceId: RUNTIME_ID },
    endpoints: [{ port, connectHost: '127.0.0.1', protocol: 'http' }]
  })
  if (!result.ok) {
    throw new Error('grant issue failed')
  }
  result.grant.endpoints[0]!.endpointId = endpointId
  h.grantStore.consume({
    grantId: result.grant.grantId,
    deviceToken: DEVICE_TOKEN,
    runtimeInstanceId: RUNTIME_ID
  })
  h.session = new WorkspacePortTunnelSession({
    grantStore: h.grantStore,
    deviceToken: DEVICE_TOKEN,
    runtimeInstanceId: RUNTIME_ID,
    socketFactory: h.socketFactory,
    sendFrame: h.sendFrame,
    closeChannel: h.closeChannel,
    initialGrantId: result.grant.grantId,
    initialEndpoints: [{ endpointId, port, connectHost: '127.0.0.1', protocol: 'http' }]
  })
}

function openFrame(streamId: number, endpointId: number): Uint8Array {
  return encodeWorkspacePortTunnelFrame({
    opcode: WorkspacePortTunnelOpcode.Open,
    streamId,
    payload: encodeWorkspacePortTunnelEndpointId(endpointId)
  })
}
function dataFrame(streamId: number, payload: Uint8Array): Uint8Array {
  return encodeWorkspacePortTunnelFrame({
    opcode: WorkspacePortTunnelOpcode.Data,
    streamId,
    payload
  })
}
function windowUpdateFrame(streamId: number, credit: number): Uint8Array {
  return encodeWorkspacePortTunnelFrame({
    opcode: WorkspacePortTunnelOpcode.WindowUpdate,
    streamId,
    payload: encodeWorkspacePortTunnelWindowUpdatePayload(credit)
  })
}
function findFrame(
  frames: SentFrame[],
  opcode: WorkspacePortTunnelOpcode,
  streamId?: number
): SentFrame | undefined {
  return frames.find(
    (f) => f.opcode === opcode && (streamId === undefined || f.streamId === streamId)
  )
}
function countFrames(
  frames: SentFrame[],
  opcode: WorkspacePortTunnelOpcode,
  streamId: number
): number {
  return frames.filter((f) => f.opcode === opcode && f.streamId === streamId).length
}

describe('defect 1: initial grant OPEN connects exact host/port + release on zero-frame close', () => {
  it('OPEN connects to the authorized host and port from the initial grant', () => {
    const h = createHarness()
    buildSession(h, 42, 9999)
    h.session.handleBinaryFrame(openFrame(1, 42))
    expect(h.socketFactory.connects[0]?.host).toBe('127.0.0.1')
    expect(h.socketFactory.connects[0]?.port).toBe(9999)
  })
  it('releases the consumed initial grant on close even with zero binary frames', () => {
    const h = createHarness()
    const result = h.grantStore.issue({
      deviceToken: DEVICE_TOKEN,
      deviceScope: 'runtime',
      runtimeInstanceId: RUNTIME_ID,
      resolvedWorkspace: { worktreeId: 'wt-1', runtimeInstanceId: RUNTIME_ID },
      endpoints: [{ port: 3000, connectHost: '127.0.0.1', protocol: 'http' }]
    })
    if (!result.ok) {
      throw new Error('fail')
    }
    result.grant.endpoints[0]!.endpointId = 7
    h.grantStore.consume({
      grantId: result.grant.grantId,
      deviceToken: DEVICE_TOKEN,
      runtimeInstanceId: RUNTIME_ID
    })
    const session = new WorkspacePortTunnelSession({
      grantStore: h.grantStore,
      deviceToken: DEVICE_TOKEN,
      runtimeInstanceId: RUNTIME_ID,
      socketFactory: h.socketFactory,
      sendFrame: h.sendFrame,
      closeChannel: h.closeChannel,
      initialGrantId: result.grant.grantId,
      initialEndpoints: [{ endpointId: 7, port: 3000, connectHost: '127.0.0.1', protocol: 'http' }]
    })
    // Why: zero binary frames sent — just close.
    session.handleClose()
    // Why: the grant should be released — not still consumed.
    expect(h.grantStore.isConsumed(result.grant.grantId)).toBe(false)
  })
})

describe('defect 2: finishOnce suppresses late callbacks', () => {
  // Why: connect to a real refused port (port 1) so the kernel emits real
  // 'error'/'close' events. The injectable timer lets the test fire the
  // timeout synchronously and assert exactly-one-outcome + late-callback
  // suppression deterministically. vi.useFakeTimers keeps the real socket
  // events from racing the test's assertions.
  it('timeout then late connect does not invoke onConnected', () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const timer: NetSocketFactoryTimer = {
      setTimeout: (cb) => {
        setTimeout(cb, 0)
        return () => {}
      },
      now: () => 0
    }
    const factory = createNodeNetSocketFactory(timer)
    factory.connect(
      { host: '127.0.0.1', port: 1, connectTimeoutMs: 1 },
      {
        onConnected: () => calls.push('connected'),
        onRefused: () => calls.push('refused'),
        onTimeout: () => calls.push('timeout'),
        onError: () => calls.push('error')
      }
    )
    // Why: fire the timeout synchronously — settles as 'timeout'.
    vi.advanceTimersByTime(10)
    // Why: drain any late kernel events (ECONNREFUSED) — settled suppresses them.
    vi.advanceTimersByTime(100)
    expect(calls).toEqual(['timeout'])
    vi.useRealTimers()
  })
  it('cancel then late connect/error/close invokes nothing', () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const timer: NetSocketFactoryTimer = {
      setTimeout: (cb) => {
        setTimeout(cb, 0)
        return () => {}
      },
      now: () => 0
    }
    const factory = createNodeNetSocketFactory(timer)
    const handle = factory.connect(
      { host: '127.0.0.1', port: 1, connectTimeoutMs: 100 },
      {
        onConnected: () => calls.push('connected'),
        onRefused: () => calls.push('refused'),
        onTimeout: () => calls.push('timeout'),
        onError: () => calls.push('error')
      }
    )
    // Why: cancel before any event settles — all later callbacks suppressed.
    handle.cancel()
    vi.advanceTimersByTime(200)
    expect(calls).toEqual([])
    vi.useRealTimers()
  })
  it('exactly one outcome when timeout fires', () => {
    const timer: NetSocketFactoryTimer = {
      setTimeout: (cb) => {
        cb()
        return () => {}
      },
      now: () => 0
    }
    const factory = createNodeNetSocketFactory(timer)
    const calls: string[] = []
    factory.connect(
      { host: '127.0.0.1', port: 1, connectTimeoutMs: 1 },
      {
        onConnected: () => calls.push('connected'),
        onRefused: () => calls.push('refused'),
        onTimeout: () => calls.push('timeout'),
        onError: () => calls.push('error')
      }
    )
    expect(calls).toEqual(['timeout'])
  })
  it('normal successful void-callback connect does not destroy the socket', async () => {
    // Why: onConnected returns void (undefined); the prior finishOnce returned
    // the callback result and treated undefined as "already settled", so every
    // successful connect destroyed the socket. Settlement now returns an
    // explicit boolean independent of the void callback.
    const server: Server = createServer(() => {
      /* accept */
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    const port = (server.address() as { port: number }).port
    const factory = createNodeNetSocketFactory()
    const calls: string[] = []
    let connectedSocket: unknown = null
    await new Promise<void>((res) => {
      factory.connect(
        { host: '127.0.0.1', port, connectTimeoutMs: 5000 },
        {
          onConnected: (s) => {
            calls.push('connected')
            connectedSocket = s as unknown

            res()
          },
          onRefused: () => {
            calls.push('refused')
            res()
          },
          onTimeout: () => {
            calls.push('timeout')
            res()
          },
          onError: () => {
            calls.push('error')
            res()
          }
        }
      )
    })
    expect(calls).toEqual(['connected'])
    // Why: the socket must NOT be destroyed — a successful connect is live.
    expect((connectedSocket as { destroyed?: boolean })?.destroyed).toBe(false)
    ;(connectedSocket as { destroy?: () => void })?.destroy?.()
    server.close()
  })
})

describe('defect 3: active stream cap at 64', () => {
  it('rejects OPEN beyond the 64-stream cap with bounded OPEN_ERROR', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    // Why: open 64 streams (the cap)
    for (let i = 1; i <= 64; i++) {
      h.session.handleBinaryFrame(openFrame(i, 1))
      h.socketFactory.pendingConnects[0]?.resolve(createFakeSocket())
    }
    expect(h.session.activeStreamCount).toBe(64)
    // Why: 65th stream should be rejected
    h.session.handleBinaryFrame(openFrame(65, 1))
    const err = findFrame(h.sentFrames, WorkspacePortTunnelOpcode.OpenError, 65)
    expect(err).toBeDefined()
    expect(h.session.activeStreamCount).toBe(64)
  })
})

describe('defect 4: pause/resume source on credit/backpressure', () => {
  it('pauses source when credit is exhausted', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: drain all credit
    socket.emitData(new Uint8Array(256 * 1024).fill(1))
    expect(socket.pauseCalls).toBeGreaterThan(0)
  })
  it('resumes source after WINDOW_UPDATE', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    socket.emitData(new Uint8Array(256 * 1024).fill(1))
    expect(socket.pauseCalls).toBeGreaterThan(0)
    h.session.handleBinaryFrame(windowUpdateFrame(1, 1024))
    expect(socket.resumeCalls).toBeGreaterThan(0)
  })
})

describe('defect 5: mixed true/false writes + drain credit', () => {
  it('returns WINDOW_UPDATE for write(true) immediately and write(false) on drain', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: write returns true → immediate WINDOW_UPDATE
    socket.writeReturnValue = true
    h.session.handleBinaryFrame(dataFrame(1, new Uint8Array(100).fill(1)))
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.WindowUpdate, 1)).toBe(1)
    // Why: write returns false → no WINDOW_UPDATE yet
    socket.writeReturnValue = false
    h.session.handleBinaryFrame(dataFrame(1, new Uint8Array(200).fill(2)))
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.WindowUpdate, 1)).toBe(1)
    // Why: drain → WINDOW_UPDATE for the pending 200 bytes
    socket.emitDrain()
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.WindowUpdate, 1)).toBe(2)
    const wuFrames = h.sentFrames.filter(
      (f) => f.opcode === WorkspacePortTunnelOpcode.WindowUpdate && f.streamId === 1
    )
    const totalCredit = wuFrames.reduce(
      (acc, f) => acc + (decodeWorkspacePortTunnelWindowUpdatePayload(f.payload) ?? 0),
      0
    )
    expect(totalCredit).toBe(300)
  })
  it('resets stream when client exceeds 256 KiB receive window', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: write returns false so no credit is returned
    socket.writeReturnValue = false
    // Why: send >256 KiB in ≤64 KiB DATA frames (wire max) without any
    // WINDOW_UPDATE coming back. The receive window is exceeded → RESET.
    for (let i = 0; i < 5; i++) {
      h.session.handleBinaryFrame(dataFrame(1, new Uint8Array(64 * 1024).fill(i)))
    }
    // Why: the stream should be reset for exceeding the receive window
    expect(findFrame(h.sentFrames, WorkspacePortTunnelOpcode.Reset, 1)).toBeDefined()
  })
})

describe('defect 6: FIN-after-queued-DATA under zero credit', () => {
  it('emits FIN immediately after DATA drains even at exact-zero credit (no WINDOW_UPDATE needed)', () => {
    // Why: a zero-byte FIN sentinel consumes no DATA credit, so it must emit
    // once prior DATA drained — even when the stream's send credit is exactly
    // zero. Prior code checked credit<=0 before recognizing the zero payload,
    // so the FIN sentinel was skipped indefinitely.
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: drain credit to exactly zero.
    socket.emitData(new Uint8Array(256 * 1024).fill(1))
    // Why: source ends — FIN sentinel enqueued; pump emits it immediately.
    socket.emitEnd()
    const dataFrames = h.sentFrames.filter(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Data && f.streamId === 1
    )
    const totalDataBytes = dataFrames.reduce((acc, f) => acc + f.payload.byteLength, 0)
    expect(totalDataBytes).toBe(256 * 1024)
    expect(findFrame(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBeDefined()
    // Why: remote has not half-closed, so the stream stays (local-only close).
    // FIN was emitted but the stream waits for the remote half-close.
    expect(h.session.activeStreamCount).toBe(1)
  })
  it('preserves byte order: queued DATA before FIN', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    socket.emitData(new Uint8Array([1, 2, 3]))
    socket.emitEnd()
    // Why: DATA should come before FIN in the sent frames order
    const dataIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Data && f.streamId === 1
    )
    const finIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Fin && f.streamId === 1
    )
    expect(dataIdx).toBeGreaterThanOrEqual(0)
    expect(finIdx).toBeGreaterThan(dataIdx)
  })
  it('emits FIN after queued DATA drains under transport backpressure', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: block the transport so DATA queues in the retry queue.
    h.sendReturn.value = false
    socket.emitData(new Uint8Array([10, 20, 30]))
    socket.emitEnd()
    expect(findFrame(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBeUndefined()
    // Why: writable resumes — DATA then FIN must flush in order.
    h.sendReturn.value = true
    h.session.notifyTransportWritable()
    const dataIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Data && f.streamId === 1
    )
    const finIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Fin && f.streamId === 1
    )
    expect(dataIdx).toBeGreaterThanOrEqual(0)
    expect(finIdx).toBeGreaterThan(dataIdx)
  })
  it('preserves exact DATA then FIN across normal close under zero credit', () => {
    // Why: onSourceClose(hadError=false) must NOT drop queued DATA/FIN. The
    // stream stays until the pump drains all DATA + the FIN sentinel. Prior
    // code called removeStream on normal close, dropping queued egress.
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: block transport so DATA + FIN queue up.
    h.sendReturn.value = false
    socket.emitData(new Uint8Array([1, 2, 3, 4]))
    socket.emitEnd()
    // Why: normal close (no error) — must NOT remove the stream; queued
    // DATA/FIN must survive.
    socket.emitClose(false)
    expect(h.session.activeStreamCount).toBe(1)
    expect(findFrame(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBeUndefined()
    // Why: writable resumes — DATA then FIN flush in exact order.
    h.sendReturn.value = true
    h.session.notifyTransportWritable()
    const dataIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Data && f.streamId === 1
    )
    const finIdx = h.sentFrames.findIndex(
      (f) => f.opcode === WorkspacePortTunnelOpcode.Fin && f.streamId === 1
    )
    expect(dataIdx).toBeGreaterThanOrEqual(0)
    expect(finIdx).toBeGreaterThan(dataIdx)
    // Why: remote has not half-closed, so the stream stays (local-only close).
    expect(h.session.activeStreamCount).toBe(1)
  })
})

describe('defect 7+9: bounded retry + pump after drain on writable', () => {
  it('sendFrame(false) queues, writable resumes with pump', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: make sendFrame return false to simulate backpressure
    h.sendReturn.value = false
    socket.emitData(new Uint8Array(100).fill(1))
    // Why: no DATA sent because transport is blocked
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)).toBe(0)
    // Why: restore sendFrame to true and notify writable
    h.sendReturn.value = true
    h.session.notifyTransportWritable()
    // Why: DATA should now be sent (retry drained + egress pumped)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)).toBeGreaterThan(0)
  })
})

describe('defect 10: onSourceError cleanup exactly once', () => {
  it('emits exactly one RESET for error then close', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    socket.emitError()
    socket.emitClose(true)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Reset, 1)).toBe(1)
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(h.session.activeStreamCount).toBe(0)
  })
})

describe('defect 11: accumulated per-stream byte budget fairness', () => {
  it('a chatty stream cannot starve another across frames in one drain', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(10, 1))
    h.session.handleBinaryFrame(openFrame(11, 1))
    // Why: capture the actual sockets the streams are bound to so data flows
    // into the right streams. The prior test resolved with throwaway sockets.
    const sockA = createFakeSocket()
    const sockB = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(sockA)
    h.socketFactory.pendingConnects[0]!.resolve(sockB)
    // Why: stream 10 emits 4x 32 KiB = 128 KiB; stream 11 emits 1x 32 KiB
    // Both have 256 KiB credit. The per-stream byte budget per drain round
    // is 64 KiB, so stream 10 sends at most 64 KiB per round and stream 11
    // gets a turn in the same round.
    sockA.emitData(new Uint8Array(32 * 1024).fill(0xaa))
    sockA.emitData(new Uint8Array(32 * 1024).fill(0xaa))
    sockA.emitData(new Uint8Array(32 * 1024).fill(0xaa))
    sockA.emitData(new Uint8Array(32 * 1024).fill(0xaa))
    sockB.emitData(new Uint8Array(32 * 1024).fill(0xbb))
    // Why: both streams should have sent frames
    const aFrames = countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 10)
    const bFrames = countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 11)
    expect(aFrames).toBeGreaterThan(0)
    expect(bFrames).toBeGreaterThan(0)
  })
})

describe('defect 12: AUTHORIZED identifies newly accepted endpoints', () => {
  it('AUTHORIZED contains only the new grant endpoints, not all prior', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    // Why: issue a second grant and AUTHORIZE it
    const result = h.grantStore.issue({
      deviceToken: DEVICE_TOKEN,
      deviceScope: 'runtime',
      runtimeInstanceId: RUNTIME_ID,
      resolvedWorkspace: { worktreeId: 'wt-1', runtimeInstanceId: RUNTIME_ID },
      endpoints: [{ port: 4000, connectHost: '127.0.0.1', protocol: 'http' }]
    })
    if (!result.ok) {
      throw new Error('fail')
    }
    result.grant.endpoints[0]!.endpointId = 99
    const grantIdBytes = new TextEncoder().encode(result.grant.grantId)
    const payload = new Uint8Array(4 + grantIdBytes.byteLength)
    new DataView(payload.buffer).setUint32(0, grantIdBytes.byteLength, false)
    payload.set(grantIdBytes, 4)
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Authorize,
        streamId: 0,
        payload
      })
    )
    const authorized = findFrame(h.sentFrames, WorkspacePortTunnelOpcode.Authorized)
    expect(authorized).toBeDefined()
    const decoded = decodeWorkspacePortTunnelAuthorizedPayload(authorized!.payload)
    // Why: should contain only endpoint 99, not endpoint 1
    expect(decoded?.endpointIds).toEqual([99])
  })
})

describe('defect 13: idempotent close', () => {
  it('double close does not throw or double-release', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleClose()
    expect(() => h.session.handleClose()).not.toThrow()
    expect(h.session.isClosed).toBe(true)
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(h.session.activeStreamCount).toBe(0)
  })
})

describe('defect 4: unified retry budget + reset stream drop + no DATA/FIN after RESET', () => {
  it('retry queue accounts against the same 16 MiB channel budget (egress + retry)', () => {
    // Why: prior code had a separate 16 MiB retry budget, allowing 32 MiB
    // aggregate. The retry queue now accounts egress queued bytes against the
    // same cap.
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: block transport so DATA queues in retry.
    h.sendReturn.value = false
    socket.emitData(new Uint8Array(64 * 1024).fill(1))
    // Why: egress drained → retry queued. channelQueuedBytes counts both.
    expect(h.session.channelQueuedBytes).toBeGreaterThan(0)
    expect(h.session.retryQueuedBytes).toBeGreaterThan(0)
    // Why: total channel bytes = egress + retry, within one 16 MiB budget.
    expect(h.session.channelQueuedBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
  it('reset stream drops all its queued retry frames so no DATA/FIN sends after RESET', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    // Why: block transport, queue DATA + FIN for stream 1.
    h.sendReturn.value = false
    socket.emitData(new Uint8Array(100).fill(1))
    socket.emitEnd()
    // Why: client sends RESET — the server cleans up, no RESET echo.
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Reset,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(h.session.activeStreamCount).toBe(0)
    const dataCount = countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)
    const finCount = countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)
    expect(dataCount).toBe(0)
    expect(finCount).toBe(0)
    // Why: flush retry queue — no DATA/FIN for stream 1 escapes.
    h.sendReturn.value = true
    h.session.notifyTransportWritable()
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)).toBe(0)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBe(0)
  })
  it('control-frame retry overflow closes the channel', () => {
    // Why: a control frame (e.g. OPENED) that overflows the retry budget
    // closes the channel, not silently drops. Fill the retry queue's
    // aggregate budget directly, then push a control frame that exceeds the
    // remaining budget — the session must close the channel.
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.sendReturn.value = false
    let closed = false
    h.closeChannel.mockImplementation(() => {
      closed = true
    })
    const outbound = (
      h.session as unknown as {
        outbound: {
          enqueueOrSend: (f: {
            streamId: number
            opcode: WorkspacePortTunnelOpcode
            payload: Uint8Array
          }) => boolean
        }
      }
    ).outbound
    // Why: fill ~16 MiB of retry with DATA frames (stream 1) under the
    // unified budget. Egress is empty (no source data), so the full 16 MiB
    // is available to retry.
    const chunk = new Uint8Array(64 * 1024).fill(1)
    for (let i = 0; i < 256; i++) {
      outbound.enqueueOrSend({
        streamId: 1,
        opcode: WorkspacePortTunnelOpcode.Data,
        payload: chunk
      })
    }
    // Why: now a control frame (OPENED) exceeds the remaining budget.
    outbound.enqueueOrSend({
      streamId: 2,
      opcode: WorkspacePortTunnelOpcode.Opened,
      payload: encodeWorkspacePortTunnelEndpointId(1)
    })
    expect(closed).toBe(true)
  })
})
describe('defect 2: normal close preserves egress state until drained', () => {
  it('end then close under zero credit/backpressure preserves exact DATA then FIN', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)

    // Why: block transport so DATA/FIN queue
    h.sendReturn.value = false
    socket.emitData(new Uint8Array(100).fill(1))
    socket.emitEnd()
    // Why: close with hadError=false, simulating a normal TCP close after end
    socket.emitClose(false)

    expect(h.session.activeStreamCount).toBe(1)

    // Now grant credit and unblock transport
    h.sendReturn.value = true
    h.session.notifyTransportWritable()

    // Everything should have drained, stream should be removed
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(h.session.activeStreamCount).toBe(0)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)).toBe(2)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBe(1)
  })
})

describe('defect 3: zero-byte FIN sentinel emits at zero credit', () => {
  it('exact-credit DATA drains to zero then FIN without WINDOW_UPDATE', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)

    // The initial credit is WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES = 256 KiB
    // We will emit exactly 256 KiB
    socket.emitData(new Uint8Array(256 * 1024).fill(1))
    socket.emitEnd()

    // Both DATA and FIN should be sent. The credit is 0 after DATA,
    // but FIN should emit regardless.
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Data, 1)).toBeGreaterThan(0)
    expect(countFrames(h.sentFrames, WorkspacePortTunnelOpcode.Fin, 1)).toBe(1)
  })
})

describe('defect 4 extra: retry overflow ordering/memory tests', () => {
  it('dropStream preserves ordering of other streams and updates memory accurately', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.sendReturn.value = false
    // oxlint-disable-next-line typescript/no-explicit-any
    const outbound = (h.session as any).outbound

    const chunk1 = new Uint8Array(100).fill(1)
    const chunk2 = new Uint8Array(200).fill(2)
    const chunk3 = new Uint8Array(300).fill(3)

    outbound.enqueueOrSend({ streamId: 1, opcode: WorkspacePortTunnelOpcode.Data, payload: chunk1 })
    outbound.enqueueOrSend({ streamId: 2, opcode: WorkspacePortTunnelOpcode.Data, payload: chunk2 })
    outbound.enqueueOrSend({ streamId: 1, opcode: WorkspacePortTunnelOpcode.Data, payload: chunk1 })
    outbound.enqueueOrSend({ streamId: 3, opcode: WorkspacePortTunnelOpcode.Data, payload: chunk3 })
    outbound.enqueueOrSend({ streamId: 2, opcode: WorkspacePortTunnelOpcode.Data, payload: chunk2 })

    expect(outbound.queuedBytesTotal()).toBe(100 + 200 + 100 + 300 + 200)

    // Drop stream 1
    outbound.dropStream(1)

    expect(outbound.queuedBytesTotal()).toBe(200 + 300 + 200)
    expect(outbound.queue.length).toBe(3)
    // Validate ordering is preserved
    expect(outbound.queue[0].streamId).toBe(2)
    expect(outbound.queue[1].streamId).toBe(3)
    expect(outbound.queue[2].streamId).toBe(2)
  })
})

describe('defect 7: local DATA+end under blocked transport, peer FIN before writable', () => {
  it('writable sends exact DATA followed by FIN and only then removes', () => {
    const h = createHarness()
    buildSession(h, 1, 3000)
    h.session.handleBinaryFrame(openFrame(1, 1))
    const socket = createFakeSocket()
    h.socketFactory.pendingConnects[0]!.resolve(socket)
    h.sentFrames.length = 0
    h.sendReturn.value = false
    const streamId = 1
    socket.emitData(new Uint8Array([10, 20, 30]))
    socket.emitEnd()
    // Now blocked, queued in OutboundRetryQueue
    h.session.handleBinaryFrame(
      encodeWorkspacePortTunnelFrame({
        opcode: WorkspacePortTunnelOpcode.Fin,
        streamId,
        payload: new Uint8Array()
      })
    )
    // Stream should not be removed yet!
    expect(h.session.activeStreamCount).toBe(1)

    // Now drain transport
    h.sendReturn.value = true
    h.session.notifyTransportWritable()

    // Check frames sent: exactly DATA then FIN
    expect(h.sentFrames.filter((f) => f.opcode === WorkspacePortTunnelOpcode.Data).length).toBe(2)
    expect(h.sentFrames.filter((f) => f.opcode === WorkspacePortTunnelOpcode.Fin).length).toBe(1)
    // Stream should now be removed
    expect(h.session.activeStreamCount).toBe(0)
  })
})
