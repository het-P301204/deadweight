/**
 * The pickle opcode reader.
 *
 * The important assertions here are the negative ones. A reader that crashes
 * on a truncated stream, or that can be made to allocate from a length field,
 * is a denial of service against the analyser by the file it is analysing --
 * and these files are the whole reason the product exists.
 */

import { describe, expect, it } from 'vitest'

import { looksLikePickle, notableGlobals, read } from './pickle.ts'

const encoder = new TextEncoder()

function bytes(...parts: Array<number | number[] | string>): Uint8Array {
  const chunks = parts.map((p) =>
    typeof p === 'number'
      ? new Uint8Array([p])
      : typeof p === 'string'
        ? encoder.encode(p)
        : new Uint8Array(p),
  )
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function shortUnicode(text: string): Uint8Array {
  const encoded = encoder.encode(text)
  return bytes(0x8c, encoded.length, [...encoded])
}

describe('read', () => {
  it('reads the protocol version from PROTO', () => {
    expect(read(bytes(0x80, 4, 0x2e)).protocol).toBe(4)
    expect(read(bytes(0x80, 5, 0x2e)).protocol).toBe(5)
    expect(read(bytes(0x7d, 0x2e)).protocol).toBeNull()
  })

  it('records the module and name a GLOBAL opcode writes', () => {
    const observation = read(bytes(0x80, 4, 0x63, 'os\nsystem\n', 0x2e))
    expect(observation.globals).toEqual(['os.system'])
  })

  it('recovers the pair a STACK_GLOBAL opcode takes off the stack', () => {
    const observation = read(
      bytes(0x80, 4, ...shortUnicode('torch._utils'), ...shortUnicode('_rebuild_tensor_v2'), 0x93, 0x2e),
    )
    expect(observation.globals).toEqual(['torch._utils._rebuild_tensor_v2'])
  })

  it('reports which opcode invokes a callable, not merely that one does', () => {
    const reduce = read(bytes(0x80, 4, 0x63, 'os\nsystem\n', 0x85, 0x52, 0x2e))
    expect(reduce.invokesCallable).toBe(true)
    expect(reduce.invokingOpcodes).toContain('REDUCE')

    const build = read(bytes(0x80, 4, 0x7d, 0x62, 0x2e))
    expect(build.invokingOpcodes).toContain('BUILD')
  })

  it('reports no invoking opcode for a stream that only carries values', () => {
    const observation = read(
      bytes(0x80, 4, 0x7d, 0x94, 0x28, ...shortUnicode('threshold'), 0x4b, 42, 0x75, 0x2e),
    )
    expect(observation.invokesCallable).toBe(false)
    expect(observation.globals).toEqual([])
  })

  it('notes the extension registry, which resolves to a callable the same way', () => {
    expect(read(bytes(0x80, 4, 0x82, 7, 0x52, 0x2e)).globals).toEqual(['<extension-registry>'])
  })

  it('stops at STOP and ignores whatever follows', () => {
    const observation = read(bytes(0x80, 4, 0x2e, 0x63, 'os\nsystem\n'))
    expect(observation.globals).toEqual([])
  })

  /* ---- hostile input ---------------------------------------------------- */

  it('does not throw on an empty buffer', () => {
    expect(() => read(new Uint8Array(0))).not.toThrow()
  })

  it('does not throw on a stream truncated mid-opcode', () => {
    // GLOBAL with no newline-terminated module name.
    const observation = read(bytes(0x80, 4, 0x63, 'os'))
    expect(observation.truncated).toBe(true)
    expect(observation.globals).toEqual([])
  })

  it('does not throw when PROTO has no version byte', () => {
    expect(read(bytes(0x80)).truncated).toBe(true)
  })

  it('refuses a length field larger than the buffer instead of allocating for it', () => {
    // BINUNICODE claiming 0xFFFFFFFF bytes of payload.
    const observation = read(bytes(0x80, 4, 0x58, [0xff, 0xff, 0xff, 0xff], 'ab'))
    expect(observation.truncated).toBe(true)
  })

  it('survives a BINBYTES8 with an implausible 64-bit length', () => {
    const observation = read(
      bytes(0x80, 5, 0x8e, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]),
    )
    expect(observation.truncated).toBe(true)
  })

  it('terminates on a buffer of nothing but MARK opcodes', () => {
    const observation = read(new Uint8Array(200_000).fill(0x28))
    expect(observation.invokesCallable).toBe(false)
  })

  it('reports truncation rather than scanning past the opcode cap', () => {
    // 30k zero-argument opcodes, past MAX_PICKLE_OPCODES.
    const observation = read(new Uint8Array(30_000).fill(0x94))
    expect(observation.truncated).toBe(true)
  })

  it('does not treat a right paren inside a string as structure', () => {
    const observation = read(bytes(0x80, 4, ...shortUnicode('os\nsystem\n'), 0x2e))
    // The text is a value, not a GLOBAL argument.
    expect(observation.globals).toEqual([])
  })
})

describe('looksLikePickle', () => {
  it('accepts a framed protocol 2 to 5 stream', () => {
    for (const version of [2, 3, 4, 5]) {
      expect(looksLikePickle(bytes(0x80, version, 0x2e))).toBe(true)
    }
  })

  it('rejects a protocol byte outside the defined range', () => {
    expect(looksLikePickle(bytes(0x80, 9, 0x2e))).toBe(false)
  })

  it('accepts an unframed protocol 0 stream that names a global', () => {
    expect(looksLikePickle(bytes(0x63, 'os\nsystem\n', 0x2e))).toBe(true)
  })

  it('rejects a zip archive, a safetensors header and plain text', () => {
    expect(looksLikePickle(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
    expect(looksLikePickle(bytes([8, 0, 0, 0, 0, 0, 0, 0], '{'))).toBe(false)
    expect(looksLikePickle(encoder.encode('hello, this is a text file'))).toBe(false)
  })

  it('rejects a buffer too short to decide', () => {
    expect(looksLikePickle(new Uint8Array([0x80]))).toBe(false)
  })
})

describe('notableGlobals', () => {
  it('quotes names worth looking at', () => {
    expect(notableGlobals(['os.system', 'collections.OrderedDict'])).toEqual(['os.system'])
  })

  it('returns nothing for an ordinary checkpoint, which proves nothing', () => {
    expect(notableGlobals(['torch._utils._rebuild_tensor_v2', 'collections.OrderedDict'])).toEqual(
      [],
    )
  })
})
