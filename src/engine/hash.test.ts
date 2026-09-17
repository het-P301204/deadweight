import { describe, expect, it } from 'vitest'

import { canonicalJson, Sha256, sha256Bytes, sha256Text } from './hash.ts'

const encoder = new TextEncoder()

describe('sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Text('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Text('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('matches the million-a vector', () => {
    const hash = new Sha256()
    const chunk = encoder.encode('a'.repeat(1000))
    for (let i = 0; i < 1000; i += 1) hash.update(chunk)
    expect(hash.digest()).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('is independent of how the input is chunked', () => {
    const data = encoder.encode('the same bytes, split three ways, must hash identically')
    const whole = sha256Bytes(data)

    const inThrees = new Sha256()
    for (let at = 0; at < data.length; at += 3) inThrees.update(data.subarray(at, at + 3))

    const lopsided = new Sha256()
    lopsided.update(data.subarray(0, 1))
    lopsided.update(data.subarray(1, 2))
    lopsided.update(data.subarray(2))

    expect(inThrees.digest()).toBe(whole)
    expect(lopsided.digest()).toBe(whole)
  })

  it('hashes exactly at the block boundary', () => {
    // 55, 56 and 64 bytes exercise the three padding branches.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120]) {
      const data = new Uint8Array(length).fill(0x61)
      const streamed = new Sha256()
      streamed.update(data.subarray(0, Math.floor(length / 2)))
      streamed.update(data.subarray(Math.floor(length / 2)))
      expect(streamed.digest()).toBe(sha256Bytes(data))
    }
  })

  it('refuses to be used twice', () => {
    const hash = new Sha256().update(encoder.encode('x'))
    hash.digest()
    expect(() => hash.digest()).toThrow(/twice/)
    expect(() => hash.update(encoder.encode('y'))).toThrow(/after digest/)
  })
})

describe('canonicalJson', () => {
  it('sorts keys so that insertion order cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })

  it('sorts nested keys too', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}')
  })

  it('preserves array order, which is data rather than layout', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('drops undefined properties instead of emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('writes non-finite numbers as null rather than producing invalid JSON', () => {
    expect(canonicalJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe(
      '{"a":null,"b":null}',
    )
    expect(() => JSON.parse(canonicalJson({ a: Number.NaN }))).not.toThrow()
  })
})
