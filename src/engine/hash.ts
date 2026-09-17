/**
 * SHA-256, written out rather than imported.
 *
 * Two reasons it is not `node:crypto` or `crypto.subtle`. The engine runs
 * unchanged in a browser tab and in the CLI, and `subtle.digest` is async
 * while `node:crypto` does not exist in the tab. And digests here are
 * computed incrementally over 64 KiB chunks of files that may be gigabytes,
 * which neither one-shot API does without holding the whole file.
 *
 * FIPS 180-4. Checked against the standard vectors in hash.test.ts.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const HEX = '0123456789abcdef'

export class Sha256 {
  private h: Uint32Array
  private readonly block: Uint8Array
  private readonly w: Uint32Array
  private blockLength: number
  private totalLength: number
  private finished: boolean

  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ])
    this.block = new Uint8Array(64)
    this.w = new Uint32Array(64)
    this.blockLength = 0
    this.totalLength = 0
    this.finished = false
  }

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update after digest')
    this.totalLength += chunk.length
    let offset = 0

    if (this.blockLength > 0) {
      const need = 64 - this.blockLength
      const take = Math.min(need, chunk.length)
      this.block.set(chunk.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset = take
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }

    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset)
      offset += 64
    }

    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0)
      this.blockLength = chunk.length - offset
    }
    return this
  }

  digest(): string {
    if (this.finished) throw new Error('Sha256: digest called twice')
    this.finished = true

    const bitLength = this.totalLength * 8
    const tail = new Uint8Array(this.blockLength < 56 ? 64 : 128)
    tail.set(this.block.subarray(0, this.blockLength), 0)
    tail[this.blockLength] = 0x80

    // Length is a 64-bit big-endian bit count. JavaScript numbers are exact to
    // 2^53, which is 1 PiB of input -- well past every limit in limits.ts.
    const high = Math.floor(bitLength / 0x100000000)
    const low = bitLength >>> 0
    const at = tail.length - 8
    tail[at] = (high >>> 24) & 0xff
    tail[at + 1] = (high >>> 16) & 0xff
    tail[at + 2] = (high >>> 8) & 0xff
    tail[at + 3] = high & 0xff
    tail[at + 4] = (low >>> 24) & 0xff
    tail[at + 5] = (low >>> 16) & 0xff
    tail[at + 6] = (low >>> 8) & 0xff
    tail[at + 7] = low & 0xff

    for (let i = 0; i < tail.length; i += 64) this.compress(tail, i)

    let out = ''
    for (let i = 0; i < 8; i += 1) {
      const word = this.h[i] as number
      for (let shift = 28; shift >= 0; shift -= 4) {
        out += HEX[(word >>> shift) & 0xf]
      }
    }
    return out
  }

  private compress(data: Uint8Array, start: number): void {
    const w = this.w
    for (let i = 0; i < 16; i += 1) {
      const j = start + i * 4
      w[i] =
        ((data[j] as number) << 24) |
        ((data[j + 1] as number) << 16) |
        ((data[j + 2] as number) << 8) |
        (data[j + 3] as number)
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number
      const y = w[i - 2] as number
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }

    let a = this.h[0] as number
    let b = this.h[1] as number
    let c = this.h[2] as number
    let d = this.h[3] as number
    let e = this.h[4] as number
    let f = this.h[5] as number
    let g = this.h[6] as number
    let h = this.h[7] as number

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }

    this.h[0] = ((this.h[0] as number) + a) | 0
    this.h[1] = ((this.h[1] as number) + b) | 0
    this.h[2] = ((this.h[2] as number) + c) | 0
    this.h[3] = ((this.h[3] as number) + d) | 0
    this.h[4] = ((this.h[4] as number) + e) | 0
    this.h[5] = ((this.h[5] as number) + f) | 0
    this.h[6] = ((this.h[6] as number) + g) | 0
    this.h[7] = ((this.h[7] as number) + h) | 0
  }
}

export function sha256Bytes(data: Uint8Array): string {
  return new Sha256().update(data).digest()
}

const encoder = new TextEncoder()

export function sha256Text(text: string): string {
  return new Sha256().update(encoder.encode(text)).digest()
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, no
 * `undefined`. Two analyses of the same tree must produce byte-identical
 * output, which means the digest cannot depend on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value)
}

function stringify(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null'
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null'
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`).join(',')}}`
}

/** Short, stable identifier derived from a string. Used for element ids. */
export function shortId(input: string): string {
  return sha256Text(input).slice(0, 12)
}
