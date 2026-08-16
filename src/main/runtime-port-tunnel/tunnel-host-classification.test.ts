import { describe, expect, it } from 'vitest'
import {
  LOOPBACK_HOSTS,
  WILDCARD_HOSTS,
  isLoopbackLiteral,
  isPrivateOrPublicIpLiteral,
  isWildcardHost,
  normalizeLoopbackBindHost
} from './tunnel-host-classification'

describe('isWildcardHost', () => {
  it.each([...WILDCARD_HOSTS])('recognizes wildcard %s', (host) => {
    expect(isWildcardHost(host)).toBe(true)
  })
  it('is case-insensitive', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true)
  })
  it('rejects loopback and hostnames', () => {
    expect(isWildcardHost('127.0.0.1')).toBe(false)
    expect(isWildcardHost('localhost')).toBe(false)
    expect(isWildcardHost('dev.local')).toBe(false)
    expect(isWildcardHost('')).toBe(false)
  })
})

describe('isLoopbackLiteral', () => {
  it.each([...LOOPBACK_HOSTS])('recognizes loopback %s', (host) => {
    expect(isLoopbackLiteral(host)).toBe(true)
  })
  it('recognizes any 127.x address', () => {
    expect(isLoopbackLiteral('127.0.0.1')).toBe(true)
    expect(isLoopbackLiteral('127.1.2.3')).toBe(true)
    expect(isLoopbackLiteral('127.255.255.254')).toBe(true)
  })
  it('recognizes ::1 with and without brackets', () => {
    expect(isLoopbackLiteral('::1')).toBe(true)
    expect(isLoopbackLiteral('[::1]')).toBe(true)
  })
  it('rejects non-loopback IPs and hostnames', () => {
    expect(isLoopbackLiteral('10.0.0.1')).toBe(false)
    expect(isLoopbackLiteral('192.168.1.1')).toBe(false)
    expect(isLoopbackLiteral('8.8.8.8')).toBe(false)
    expect(isLoopbackLiteral('dev.local')).toBe(false)
    expect(isLoopbackLiteral('::')).toBe(false)
    expect(isLoopbackLiteral('')).toBe(false)
  })
})

describe('isPrivateOrPublicIpLiteral', () => {
  it('rejects private IPv4 ranges', () => {
    expect(isPrivateOrPublicIpLiteral('10.0.0.1')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('172.16.0.1')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('192.168.1.1')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('169.254.1.1')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('100.64.0.1')).toBe(true)
  })
  it('rejects public IPv4', () => {
    expect(isPrivateOrPublicIpLiteral('8.8.8.8')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('1.1.1.1')).toBe(true)
  })
  it('rejects non-loopback IPv6', () => {
    expect(isPrivateOrPublicIpLiteral('fe80::1')).toBe(true)
    expect(isPrivateOrPublicIpLiteral('2001:db8::1')).toBe(true)
  })
  it('does not reject loopback or wildcard', () => {
    expect(isPrivateOrPublicIpLiteral('127.0.0.1')).toBe(false)
    expect(isPrivateOrPublicIpLiteral('::1')).toBe(false)
    expect(isPrivateOrPublicIpLiteral('0.0.0.0')).toBe(false)
    expect(isPrivateOrPublicIpLiteral('::')).toBe(false)
  })
  it('does not reject hostnames', () => {
    expect(isPrivateOrPublicIpLiteral('dev.local')).toBe(false)
    expect(isPrivateOrPublicIpLiteral('localhost')).toBe(false)
  })
})

describe('normalizeLoopbackBindHost', () => {
  it('normalizes wildcard and loopback to 127.0.0.1', () => {
    expect(normalizeLoopbackBindHost('0.0.0.0')).toBe('127.0.0.1')
    expect(normalizeLoopbackBindHost('*')).toBe('127.0.0.1')
    expect(normalizeLoopbackBindHost('::')).toBe('127.0.0.1')
    expect(normalizeLoopbackBindHost('localhost')).toBe('127.0.0.1')
    expect(normalizeLoopbackBindHost('127.0.0.1')).toBe('127.0.0.1')
  })
  it('preserves custom hostnames', () => {
    expect(normalizeLoopbackBindHost('dev.local')).toBe('dev.local')
  })
})