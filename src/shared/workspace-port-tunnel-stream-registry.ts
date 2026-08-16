// Workspace port tunnel stream state primitives — Stage 1.
//
// Companion to workspace-port-tunnel-protocol.ts. That file holds the binary
// codec, opcodes, and bounds; this file holds the small, well-bounded state
// machine and flow-control primitives the desktop manager and runtime session
// will share. Runtime/desktop handlers themselves are out of scope here.
//
// See docs/superpowers/specs/2026-08-15-paired-runtime-direct-browser-design.md.

import {
  WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL,
  WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID,
  WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES,
  WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES
} from './workspace-port-tunnel-protocol'
import type { WorkspacePortTunnelErrorCode } from './workspace-port-tunnel-protocol'

export type WorkspacePortTunnelStreamPhase =
  | 'idle'
  | 'opening'
  | 'open'
  | 'half-closed-local'
  | 'half-closed-remote'
  | 'closed'

export type WorkspacePortTunnelStreamState = {
  streamId: number
  endpointId: number
  phase: WorkspacePortTunnelStreamPhase
  sendCredit: number
  queuedBytes: number
  lastErrorCode: WorkspacePortTunnelErrorCode | null
}

export type WorkspacePortTunnelStreamRegistryOverflow = {
  kind: 'stream-limit-exceeded'
  limit: number
}

export type WorkspacePortTunnelStreamRegistryMutationResult =
  | { ok: true }
  | {
      ok: false
      error:
        | WorkspacePortTunnelStreamRegistryOverflow
        | { kind: 'unknown-stream' }
        | {
            kind: 'invalid-transition'
            from: WorkspacePortTunnelStreamPhase
            to: WorkspacePortTunnelStreamPhase
          }
        | { kind: 'duplicate-stream' }
        | { kind: 'invalid-byte-count' }
        | { kind: 'stream-queue-overflow'; limit: number }
        | { kind: 'channel-queue-overflow'; limit: number }
        | { kind: 'send-credit-exhausted'; available: number }
    }

export class WorkspacePortTunnelStreamRegistry {
  private readonly streams = new Map<number, WorkspacePortTunnelStreamState>()
  private readonly limit: number
  private readonly streamQueueLimit: number
  private readonly channelQueueLimit: number
  private channelQueuedBytes = 0

  constructor(options?: {
    maxActiveStreams?: number
    maxStreamQueuedBytes?: number
    maxChannelQueuedBytes?: number
  }) {
    this.limit = options?.maxActiveStreams ?? WORKSPACE_PORT_TUNNEL_MAX_ACTIVE_STREAMS_PER_CHANNEL
    this.streamQueueLimit =
      options?.maxStreamQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_STREAM_QUEUED_BYTES
    this.channelQueueLimit =
      options?.maxChannelQueuedBytes ?? WORKSPACE_PORT_TUNNEL_MAX_CHANNEL_QUEUED_BYTES
  }

  open(streamId: number, endpointId: number): WorkspacePortTunnelStreamRegistryMutationResult {
    if (this.streams.size >= this.limit) {
      return { ok: false, error: { kind: 'stream-limit-exceeded', limit: this.limit } }
    }
    if (this.streams.has(streamId)) {
      return { ok: false, error: { kind: 'duplicate-stream' } }
    }
    this.streams.set(streamId, {
      streamId,
      endpointId,
      phase: 'opening',
      sendCredit: WORKSPACE_PORT_TUNNEL_INITIAL_STREAM_RECEIVE_WINDOW_BYTES,
      queuedBytes: 0,
      lastErrorCode: null
    })
    return { ok: true }
  }

  markOpened(streamId: number): WorkspacePortTunnelStreamRegistryMutationResult {
    return this.transition(streamId, 'opening', 'open')
  }

  markOpenError(
    streamId: number,
    errorCode: WorkspacePortTunnelErrorCode
  ): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    stream.lastErrorCode = errorCode
    this.remove(streamId)
    return { ok: true }
  }

  halfCloseLocal(streamId: number): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (stream.phase === 'open') {
      return this.transition(streamId, 'open', 'half-closed-local')
    }
    if (stream.phase === 'half-closed-remote') {
      return this.transition(streamId, 'half-closed-remote', 'closed')
    }
    return {
      ok: false,
      error: { kind: 'invalid-transition', from: stream.phase, to: 'half-closed-local' }
    }
  }

  halfCloseRemote(streamId: number): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (stream.phase === 'open') {
      return this.transition(streamId, 'open', 'half-closed-remote')
    }
    if (stream.phase === 'half-closed-local') {
      return this.transition(streamId, 'half-closed-local', 'closed')
    }
    return {
      ok: false,
      error: { kind: 'invalid-transition', from: stream.phase, to: 'half-closed-remote' }
    }
  }

  reset(streamId: number): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    this.remove(streamId)
    return { ok: true }
  }

  addQueuedBytes(streamId: number, bytes: number): WorkspacePortTunnelStreamRegistryMutationResult {
    if (!Number.isInteger(bytes) || bytes < 0) {
      return { ok: false, error: { kind: 'invalid-byte-count' } }
    }
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (stream.queuedBytes + bytes > this.streamQueueLimit) {
      return { ok: false, error: { kind: 'stream-queue-overflow', limit: this.streamQueueLimit } }
    }
    if (this.channelQueuedBytes + bytes > this.channelQueueLimit) {
      return {
        ok: false,
        error: { kind: 'channel-queue-overflow', limit: this.channelQueueLimit }
      }
    }
    stream.queuedBytes += bytes
    this.channelQueuedBytes += bytes
    return { ok: true }
  }

  releaseQueuedBytes(
    streamId: number,
    bytes: number
  ): WorkspacePortTunnelStreamRegistryMutationResult {
    if (!Number.isInteger(bytes) || bytes < 0) {
      return { ok: false, error: { kind: 'invalid-byte-count' } }
    }
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    const released = Math.min(bytes, stream.queuedBytes)
    stream.queuedBytes -= released
    this.channelQueuedBytes -= released
    return { ok: true }
  }

  applyWindowUpdate(
    streamId: number,
    credit: number
  ): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (!Number.isInteger(credit) || credit < 0) {
      return { ok: false, error: { kind: 'invalid-byte-count' } }
    }
    // Cap at the 32-bit stream-id space; the wire carries a uint32 credit.
    const next = stream.sendCredit + credit
    stream.sendCredit = Math.min(next, WORKSPACE_PORT_TUNNEL_MAX_STREAM_ID)
    return { ok: true }
  }

  consumeSendCredit(
    streamId: number,
    bytes: number
  ): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      return { ok: false, error: { kind: 'invalid-byte-count' } }
    }
    if (stream.sendCredit < bytes) {
      return {
        ok: false,
        error: { kind: 'send-credit-exhausted', available: stream.sendCredit }
      }
    }
    stream.sendCredit -= bytes
    return { ok: true }
  }

  get(streamId: number): WorkspacePortTunnelStreamState | undefined {
    const stream = this.streams.get(streamId)
    return stream ? { ...stream } : undefined
  }

  size(): number {
    return this.streams.size
  }

  channelQueuedBytesTotal(): number {
    return this.channelQueuedBytes
  }

  private transition(
    streamId: number,
    from: WorkspacePortTunnelStreamPhase,
    to: WorkspacePortTunnelStreamPhase
  ): WorkspacePortTunnelStreamRegistryMutationResult {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return { ok: false, error: { kind: 'unknown-stream' } }
    }
    if (stream.phase !== from) {
      return { ok: false, error: { kind: 'invalid-transition', from: stream.phase, to } }
    }
    stream.phase = to
    if (to === 'closed') {
      this.remove(streamId)
    }
    return { ok: true }
  }

  private remove(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return
    }
    this.channelQueuedBytes = Math.max(0, this.channelQueuedBytes - stream.queuedBytes)
    this.streams.delete(streamId)
  }
}
