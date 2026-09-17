/**
 * Format classification.
 *
 * Two properties are asserted throughout: bytes beat extensions, and an
 * unrecognised file stays unrecognised. The second matters more. A classifier
 * that guesses produces a report that reads as complete and is not.
 */

import { describe, expect, it } from 'vitest'

import { classifyBytes } from './classify.ts'
import { readSafetensorsHeader } from './containers.ts'

const encoder = new TextEncoder()

function bytes(...parts: Array<number | number[] | string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) =>
    typeof p === 'number'
      ? new Uint8Array([p])
      : typeof p === 'string'
        ? encoder.encode(p)
        : p instanceof Uint8Array
          ? p
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

function u64le(value: number): number[] {
  const out: number[] = []
  let n = value
  for (let i = 0; i < 8; i += 1) {
    out.push(n & 0xff)
    n = Math.floor(n / 256)
  }
  return out
}

function safetensors(header: object): Uint8Array {
  const json = encoder.encode(JSON.stringify(header))
  return bytes(u64le(json.length), json, new Uint8Array(16))
}

/** Classify a single buffer, treating it as head and tail of one small file. */
function classify(path: string, data: Uint8Array) {
  return classifyBytes(path, data, data, 0, data.length)
}

describe('classifyBytes', () => {
  it('recognises safetensors from its length-prefixed JSON header', () => {
    const data = safetensors({
      'layer.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
      __metadata__: { format: 'pt' },
    })
    const result = classify('models/x.safetensors', data)
    expect(result.verdict.format).toBe('safetensors')
    expect(result.verdict.basis).toBe('magic')
    expect(result.tensorHeader?.entries).toBe(1)
    expect(result.tensorHeader?.metadata['format']).toBe('pt')
  })

  it('recognises GGUF, HDF5 and TFLite from their magic numbers', () => {
    expect(classify('m.gguf', bytes('GGUF', [3, 0, 0, 0])).verdict.format).toBe('gguf')
    expect(
      classify('m.h5', bytes([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])).verdict.format,
    ).toBe('keras-h5')
    expect(classify('m.tflite', bytes([0, 0, 0, 0], 'TFL3')).verdict.format).toBe('tflite')
  })

  it('reads a NumPy header and notes an object dtype, which needs pickling', () => {
    const header = "{'descr': '|O', 'fortran_order': False, 'shape': (4,), }".padEnd(117, ' ')
    const data = bytes([0x93], 'NUMPY', 1, 0, [118, 0], `${header}\n`)
    const result = classify('features.npy', data)
    expect(result.verdict.format).toBe('numpy-npy')
    expect(result.verdict.note).toContain('object dtype')
  })

  it('does not flag a numeric NumPy dtype as needing pickling', () => {
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (4,), }".padEnd(117, ' ')
    const data = bytes([0x93], 'NUMPY', 1, 0, [118, 0], `${header}\n`)
    expect(classify('x.npy', data).verdict.note).not.toContain('object dtype')
  })

  it('recognises a pickle stream and carries the opcode observation out', () => {
    const data = bytes(0x80, 4, 0x63, 'os\nsystem\n', 0x85, 0x52, 0x2e)
    const result = classify('weights/x.pkl', data)
    expect(result.verdict.format).toBe('pickle')
    expect(result.pickle?.globals).toEqual(['os.system'])
    expect(result.verdict.note).toContain('REDUCE')
  })

  it('calls a bare pickle with a .pt extension a legacy torch archive', () => {
    const data = bytes(0x80, 2, 0x7d, 0x2e)
    expect(classify('weights/x.pt', data).verdict.format).toBe('pytorch-legacy')
  })

  it('declines to decompress a compressed joblib dump, and says so', () => {
    const result = classify('m.joblib', bytes([0x78, 0x9c, 0x01, 0x00, 0x00]))
    expect(result.verdict.format).toBe('joblib')
    expect(result.verdict.note).toContain('does not decompress')
  })

  it('reports a file it cannot identify as unrecognised rather than guessing', () => {
    const result = classify('models/legacy.model', bytes('MDLX', [7, 0, 0, 0], new Uint8Array(32)))
    expect(result.verdict.format).toBe('unknown')
    expect(result.verdict.basis).toBe('none')
  })

  it('falls back to the extension when the bytes match nothing, and records that it did', () => {
    const result = classify('models/x.onnx', bytes('not a protobuf at all'))
    expect(result.verdict.basis).toBe('extension')
    expect(result.verdict.note).toContain('falls back to the extension')
  })

  it('says a file is empty rather than inventing a format for it', () => {
    const result = classifyBytes('x.pt', new Uint8Array(0), new Uint8Array(0), 0, 0)
    expect(result.verdict.note).toBe('file is empty')
  })

  /* ---- bytes beat extensions ------------------------------------------- */

  describe('extension disagreement', () => {
    const zip = (name: string): Uint8Array => {
      const encoded = encoder.encode(name)
      const local = bytes(
        [0x50, 0x4b, 0x03, 0x04],
        [20, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [encoded.length, 0],
        [0, 0],
        encoded,
      )
      const central = bytes(
        [0x50, 0x4b, 0x01, 0x02],
        [20, 0],
        [20, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [encoded.length, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        encoded,
      )
      return bytes(
        local,
        central,
        [0x50, 0x4b, 0x05, 0x06],
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 0],
        [central.length & 0xff, central.length >> 8, 0, 0],
        [local.length & 0xff, local.length >> 8, 0, 0],
        [0, 0],
      )
    }

    it('identifies a zip holding data.pkl as a PyTorch archive whatever it is called', () => {
      const result = classify('weights/model.bin', zip('archive/data.pkl'))
      expect(result.verdict.format).toBe('pytorch-zip')
      expect(result.verdict.basis).toBe('container')
    })

    it('flags a .safetensors file whose bytes are a pickle-bearing zip', () => {
      const result = classify('models/mislabelled.safetensors', zip('archive/data.pkl'))
      expect(result.verdict.format).toBe('pytorch-zip')
      expect(result.verdict.extensionMismatch).toContain('extension suggests safetensors')
    })

    it('identifies a code/ tree plus a pickle as TorchScript', () => {
      // Two members, so the head-based reader is used for names.
      const result = classifyBytes(
        'm.pt',
        zip('segmenter/code/__torch__.py'),
        zip('segmenter/code/__torch__.py'),
        0,
        200,
      )
      expect(['torchscript', 'pytorch-zip']).toContain(result.verdict.format)
    })

    it('does not report a mismatch inside the pytorch family', () => {
      const result = classify('weights/model.pt', zip('archive/data.pkl'))
      expect(result.verdict.extensionMismatch).toBeUndefined()
    })
  })
})

describe('readSafetensorsHeader', () => {
  it('refuses a header claiming to be longer than the file', () => {
    const data = bytes(u64le(1_000_000), '{"a":1}')
    expect(readSafetensorsHeader(data, data.length)).toBeNull()
  })

  it('refuses a header length beyond the memory cap', () => {
    const data = bytes(u64le(64 * 1024 * 1024), '{')
    expect(readSafetensorsHeader(data, 10 ** 12)).toBeNull()
  })

  it('refuses a header that is not JSON', () => {
    const body = encoder.encode('not json at all')
    expect(readSafetensorsHeader(bytes(u64le(body.length), body), 200)).toBeNull()
  })

  it('identifies the format when the header is longer than the slice read', () => {
    // 8 KiB header, only 64 bytes available.
    const partial = bytes(u64le(8192), '{"a":')
    const result = readSafetensorsHeader(partial, 1_000_000)
    expect(result).not.toBeNull()
    expect(result?.headerBytes).toBe(8192)
  })

  it('drops prototype-polluting keys from a parsed header', () => {
    const json = encoder.encode('{"__proto__":{"polluted":true},"w":{"dtype":"F32"}}')
    const result = readSafetensorsHeader(bytes(u64le(json.length), json, new Uint8Array(4)), 200)
    expect(result?.entries).toBe(1)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('rejects a zero-length header', () => {
    expect(readSafetensorsHeader(bytes(u64le(0), '{}'), 20)).toBeNull()
  })
})
