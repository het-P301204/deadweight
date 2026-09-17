/**
 * Generate the binary fixtures for the demo project and the test suite.
 *
 * These are not models. They are the smallest files that are genuinely
 * recognisable as each format: a real pickle opcode stream, a real zip central
 * directory, a real safetensors length-prefixed header. The analyser has to
 * identify them from their bytes, so they have to be real bytes.
 *
 * About `weights/classifier.pkl`. It contains a pickle stream that names
 * `os.system` and carries a REDUCE opcode, because a detection fixture for a
 * pickle scanner has to contain the thing being detected -- this is the same
 * shape every pickle-scanning tool keeps in its test corpus. It is inert: a
 * pickle is data until something unpickles it, DEADWEIGHT never does, and the
 * argument string is `echo DEADWEIGHT SYNTHETIC FIXTURE`. Nothing in this
 * repository, in CI, or in the browser build ever passes it to an unpickler.
 *
 * Run with `--check` to verify the committed files still match.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { sha256Bytes } from '../src/engine/hash.ts'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')

/* -------------------------------------------------------------------------- */
/* Byte helpers                                                               */
/* -------------------------------------------------------------------------- */

function bytes(...parts: Array<number | number[] | Uint8Array | string>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    if (typeof part === 'number') chunks.push(new Uint8Array([part]))
    else if (typeof part === 'string') chunks.push(new TextEncoder().encode(part))
    else if (Array.isArray(part)) chunks.push(new Uint8Array(part))
    else chunks.push(part)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u64le(value: number): number[] {
  const out: number[] = []
  let remaining = value
  for (let i = 0; i < 8; i += 1) {
    out.push(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Pickle writer                                                              */
/* -------------------------------------------------------------------------- */

const PROTO = 0x80
const GLOBAL = 0x63
const STACK_GLOBAL = 0x93
const SHORT_BINUNICODE = 0x8c
const MARK = 0x28
const TUPLE1 = 0x85
const REDUCE = 0x52
const EMPTY_DICT = 0x7d
const SETITEMS = 0x75
const MEMOIZE = 0x94
const STOP = 0x2e
const BININT1 = 0x4b
const EMPTY_TUPLE = 0x29

function shortUnicode(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  return bytes(SHORT_BINUNICODE, encoded.length, encoded)
}

/**
 * A protocol 4 stream that calls `os.system("echo ...")`.
 *
 * This is the detection fixture. See the note at the top of the file: it is
 * data, it is never unpickled anywhere in this project, and its payload is an
 * echo.
 */
function dangerousPickle(): Uint8Array {
  return bytes(
    PROTO,
    4,
    GLOBAL,
    'os\nsystem\n',
    shortUnicode('echo DEADWEIGHT SYNTHETIC FIXTURE'),
    TUPLE1,
    REDUCE,
    STOP,
  )
}

/** A protocol 5 stream that names only a tensor rebuild path, as a real checkpoint does. */
function benignStateDictPickle(): Uint8Array {
  return bytes(
    PROTO,
    5,
    EMPTY_DICT,
    MEMOIZE,
    MARK,
    shortUnicode('layer.0.weight'),
    MEMOIZE,
    STACK_GLOBAL_CALL('torch._utils', '_rebuild_tensor_v2'),
    shortUnicode('layer.0.bias'),
    MEMOIZE,
    STACK_GLOBAL_CALL('torch._utils', '_rebuild_tensor_v2'),
    SETITEMS,
    STOP,
  )
}

function STACK_GLOBAL_CALL(module: string, name: string): Uint8Array {
  return bytes(
    shortUnicode(module),
    shortUnicode(name),
    STACK_GLOBAL,
    MEMOIZE,
    EMPTY_TUPLE,
    REDUCE,
    MEMOIZE,
  )
}

/** A stream with no callable-invoking opcode at all: numbers in a dict. */
function dataOnlyPickle(): Uint8Array {
  return bytes(
    PROTO,
    4,
    EMPTY_DICT,
    MEMOIZE,
    MARK,
    shortUnicode('threshold'),
    BININT1,
    42,
    shortUnicode('version'),
    BININT1,
    3,
    SETITEMS,
    STOP,
  )
}

/* -------------------------------------------------------------------------- */
/* Zip writer                                                                 */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A stored (uncompressed) zip archive. Enough for the format classifier. */
function zip(members: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const member of members) {
    const name = new TextEncoder().encode(member.name)
    const crc = crc32(member.data)
    const local = bytes(
      u32le(0x04034b50),
      u16le(20),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(member.data.length),
      u32le(member.data.length),
      u16le(name.length),
      u16le(0),
      name,
      member.data,
    )
    locals.push(local)
    centrals.push(
      bytes(
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(member.data.length),
        u32le(member.data.length),
        u16le(name.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        name,
      ),
    )
    offset += local.length
  }

  const directory = bytes(...centrals)
  return bytes(
    ...locals,
    directory,
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(members.length),
    u16le(members.length),
    u32le(directory.length),
    u32le(offset),
    u16le(0),
  )
}

/* -------------------------------------------------------------------------- */
/* Format writers                                                             */
/* -------------------------------------------------------------------------- */

function safetensors(
  tensors: ReadonlyArray<{ name: string; dtype: string; shape: number[] }>,
  metadata: Record<string, string> = {},
): Uint8Array {
  const header: Record<string, unknown> = {}
  let at = 0
  for (const tensor of tensors) {
    const elements = tensor.shape.reduce((n, d) => n * d, 1)
    const width = tensor.dtype === 'F32' ? 4 : tensor.dtype === 'F16' || tensor.dtype === 'BF16' ? 2 : 1
    const size = elements * width
    header[tensor.name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [at, at + size] }
    at += size
  }
  if (Object.keys(metadata).length > 0) header['__metadata__'] = metadata
  const json = new TextEncoder().encode(JSON.stringify(header))
  // Buffers are zeroes: the header is what identifies the format, and a
  // fixture does not need weights.
  return bytes(u64le(json.length), json, new Uint8Array(at))
}

function onnx(producer: string): Uint8Array {
  // field 1 (ir_version) varint, field 2 (producer_name) length-delimited.
  const name = new TextEncoder().encode(producer)
  return bytes(0x08, 0x09, 0x12, name.length, name, 0x1a, 0x05, '1.0.0')
}

function gguf(): Uint8Array {
  // magic, version 3, tensor count 0, kv count 1, then one string kv pair.
  const key = new TextEncoder().encode('general.architecture')
  const value = new TextEncoder().encode('llama')
  return bytes(
    'GGUF',
    u32le(3),
    u64le(0),
    u64le(1),
    u64le(key.length),
    key,
    u32le(8),
    u64le(value.length),
    value,
  )
}

function npy(descr: string, shape: string): Uint8Array {
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shape}, }`
  const padded = dict.padEnd(Math.ceil((10 + dict.length + 1) / 64) * 64 - 11, ' ') + '\n'
  return bytes([0x93], 'NUMPY', 1, 0, u16le(padded.length), padded, new Uint8Array(32))
}

function hdf5(): Uint8Array {
  return bytes([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(56))
}

function zlibWrapped(payload: Uint8Array): Uint8Array {
  // A zlib header with a stored deflate block. joblib compresses a pickle, and
  // the point of the fixture is that DEADWEIGHT recognises the wrapper and
  // declines to decompress it.
  const length = payload.length
  return bytes(
    [0x78, 0x9c],
    [0x01],
    u16le(length),
    u16le(~length & 0xffff),
    payload,
    u32le(0),
  )
}

function unrecognised(): Uint8Array {
  // Deliberately matches no signature: a proprietary container header.
  return bytes('MDLX', u32le(7), u32le(1), new Uint8Array(48))
}

/* -------------------------------------------------------------------------- */
/* The fixture set                                                            */
/* -------------------------------------------------------------------------- */

export function fixtures(): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()

  files.set('weights/classifier.pkl', dangerousPickle())
  files.set('weights/thresholds.pkl', dataOnlyPickle())
  files.set(
    'weights/ranker.bin',
    zip([
      { name: 'archive/data.pkl', data: benignStateDictPickle() },
      { name: 'archive/data/0', data: new Uint8Array(64) },
      { name: 'archive/version', data: new TextEncoder().encode('3\n') },
    ]),
  )
  files.set(
    'weights/ranker.safetensors',
    safetensors(
      [
        { name: 'layer.0.weight', dtype: 'F32', shape: [8, 8] },
        { name: 'layer.0.bias', dtype: 'F32', shape: [8] },
      ],
      { format: 'pt', deadweight_fixture: 'synthetic' },
    ),
  )
  files.set(
    'models/encoder.safetensors',
    safetensors(
      [
        { name: 'embeddings.weight', dtype: 'F16', shape: [16, 8] },
        { name: 'encoder.layer.0.attention.q.weight', dtype: 'F16', shape: [8, 8] },
      ],
      { format: 'pt' },
    ),
  )
  files.set(
    'models/segmenter.ts.pt',
    zip([
      { name: 'segmenter/code/__torch__.py', data: new TextEncoder().encode('# torchscript\n') },
      { name: 'segmenter/constants.pkl', data: dataOnlyPickle() },
      { name: 'segmenter/data.pkl', data: benignStateDictPickle() },
    ]),
  )
  files.set('models/detector.onnx', onnx('pytorch'))
  files.set('models/tiny-llm.gguf', gguf())
  files.set('models/features.npy', npy('|O', '(4,)'))
  files.set('models/embeddings.npy', npy('<f4', '(8, 4)'))
  files.set('models/vision.h5', hdf5())
  files.set('models/legacy.model', unrecognised())
  files.set('models/pipeline.joblib', zlibWrapped(dangerousPickle()))
  files.set(
    'models/report.keras',
    zip([
      { name: 'config.json', data: new TextEncoder().encode('{"class_name":"Sequential"}') },
      { name: 'metadata.json', data: new TextEncoder().encode('{"keras_version":"3.5.0"}') },
      { name: 'model.weights.h5', data: hdf5() },
    ]),
  )
  // A `.safetensors` name over a zip: the extension and the bytes disagree,
  // which is a finding rather than a nit.
  files.set(
    'models/mislabelled.safetensors',
    zip([{ name: 'archive/data.pkl', data: benignStateDictPickle() }]),
  )

  return files
}

/* -------------------------------------------------------------------------- */
/* The malformed corpus                                                       */
/*                                                                            */
/* Inputs the analyser has to refuse, or survive, without throwing. They      */
/* double as documentation of each failure mode, and the test suite walks the */
/* directory rather than listing them, so adding one here adds a test.        */
/* -------------------------------------------------------------------------- */

export function malformed(): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const text = (body: string): Uint8Array => new TextEncoder().encode(body)

  /* --- artifacts -------------------------------------------------------- */

  // A pickle that ends in the middle of a GLOBAL argument.
  files.set('weights/truncated.pkl', bytes(PROTO, 4, GLOBAL, 'os'))

  // BINUNICODE claiming 0xFFFFFFFF bytes of payload, followed by two.
  files.set('weights/oversized-length.pkl', bytes(PROTO, 4, 0x58, u32le(0xffffffff), 'ab'))

  // Thirty thousand zero-argument opcodes, past the opcode cap.
  files.set('weights/opcode-flood.pkl', bytes(PROTO, 4, new Uint8Array(30_000).fill(MEMOIZE)))

  // Zip magic and nothing else: no central directory to read.
  files.set('weights/broken-zip.pt', bytes(u32le(0x04034b50), new Uint8Array(8)))

  // A safetensors header claiming to be roughly an exabyte.
  files.set(
    'weights/liar-header.safetensors',
    bytes([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f], '{'),
  )

  // Zero bytes with a model extension.
  files.set('weights/empty.pt', new Uint8Array(0))

  // A file whose extension promises safetensors and whose bytes are HDF5.
  files.set('weights/wrong-magic.safetensors', hdf5())

  /* --- source ----------------------------------------------------------- */

  // Unbalanced brackets: the loader call never closes.
  files.set('src/unbalanced.py', text('import torch\ntorch.load("x.pt"\n'))

  // One enormous line. Minified output is not source.
  files.set('src/minified.js', text(`const x=${'1+'.repeat(3000)}1\n`))

  // A loader call that exists only inside a string and a comment.
  files.set(
    'src/decoys.py',
    text(
      [
        'import torch',
        '# torch.load("commented.pt")',
        'HELP = "call torch.load(path) to load it"',
        'DOC = """',
        'torch.load("docstring.pt")',
        '"""',
      ].join('\n'),
    ),
  )

  /* --- documents -------------------------------------------------------- */

  files.set('notebooks/not-json.ipynb', text('{"cells": [oh no\n'))
  files.set('notebooks/no-code-cells.ipynb', text('{"cells":[{"cell_type":"markdown","source":["x"]}]}'))

  files.set(
    'security/prototype.evidence.json',
    text('{"__proto__":{"polluted":true},"records":[{"subject":"weights/empty.pt","result":"pass"}]}'),
  )
  files.set('security/not-json.evidence.json', text('{"records": [,,,'))
  files.set(
    'security/deep-nest.evidence.json',
    text(`{"records":[{"subject":"a","result":${'{"a":'.repeat(80)}1${'}'.repeat(80)}}]}`),
  )

  // A requirements file that declares nothing resolvable.
  files.set('requirements.txt', text('# nothing here\n-r other.txt\n--index-url https://x.invalid\n'))

  /* --- configuration ---------------------------------------------------- */
  /* Each of these must raise rather than be skipped: a configuration that
     looks like it declares production and does not is worse than none. */

  files.set('config/tab-indent.yaml', text('environments:\n\tproduction:\n    - src/**\n'))
  files.set('config/unknown-environment.yaml', text('environments:\n  prodution:\n    - src/**\n'))
  files.set('config/unknown-section.yaml', text('environmnts:\n  production:\n    - src/**\n'))
  files.set('config/absolute-glob.yaml', text('environments:\n  production:\n    - /etc/**\n'))
  files.set('config/traversing-glob.yaml', text('environments:\n  production:\n    - ../other/**\n'))
  files.set('config/orphan-item.yaml', text('environments:\n  - src/**\n'))
  files.set('config/not-json.json', text('{"environments":'))
  files.set('config/environments-not-object.json', text('{"environments":[]}'))

  return files
}

/* -------------------------------------------------------------------------- */
/* Evidence documents                                                         */
/*                                                                            */
/* Written from the real digests of the files above, so the binding states in */
/* the demo are computed rather than asserted:                                */
/*                                                                            */
/*   classifier.pkl  flagged, bound to the digest on disk                     */
/*   ranker.bin      passed, bound to a digest that is NOT on disk -> stale   */
/*   encoder         passed, bound                                            */
/*   pipeline.joblib skipped by the scanner, which is not the same as passed  */
/*   thresholds.pkl  no record at all                                         */
/* -------------------------------------------------------------------------- */

function evidenceDocuments(files: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const digest = (path: string): string => sha256Bytes(files.get(path) as Uint8Array)

  // A digest that is deliberately not the file on disk: the scanner ran
  // against the build before the last one.
  const supersededRanker = sha256Bytes(
    bytes('superseded-build:', files.get('weights/ranker.bin') as Uint8Array),
  )

  const native = {
    schema: 'deadweight.evidence/1',
    note: 'Synthetic evidence for the demo project. Not a real scan.',
    records: [
      {
        scanner: 'picklescan',
        version: '0.0.23',
        subject: 'weights/classifier.pkl',
        sha256: digest('weights/classifier.pkl'),
        result: 'flagged',
        detail: 'Denylisted global found in the opcode stream: os.system.',
      },
      {
        scanner: 'modelscan',
        version: '0.8.4',
        subject: 'weights/ranker.bin',
        sha256: supersededRanker,
        result: 'pass',
        detail: 'No issue reported against the scanner’s known-dangerous import list.',
      },
      {
        scanner: 'modelscan',
        version: '0.8.4',
        subject: 'models/encoder.safetensors',
        sha256: digest('models/encoder.safetensors'),
        result: 'pass',
        detail: 'safetensors header parsed; no pickle stream present.',
      },
      {
        scanner: 'fickling',
        version: '0.1.3',
        subject: 'weights/classifier.pkl',
        sha256: digest('weights/classifier.pkl'),
        result: 'flagged',
        detail: 'The pickle program calls an imported function with an attacker-controlled argument.',
      },
    ],
  }

  const modelscan = {
    modelscan_version: '0.8.4',
    input_path: '.',
    summary: {
      total_issues: 1,
      scanned: {
        total_scanned: 3,
        scanned_files: [
          'weights/classifier.pkl',
          'models/segmenter.ts.pt',
          'models/report.keras',
        ],
      },
      skipped: {
        total_skipped: 1,
        skipped_files: [{ source: 'models/pipeline.joblib', category: 'SCAN_NOT_SUPPORTED' }],
      },
    },
    issues: [
      {
        description: 'Use of unsafe operator',
        operator: 'system',
        module: 'os',
        source: 'weights/classifier.pkl',
        scanner: 'modelscan.scanners.PickleUnsafeOpScan',
        severity: 'CRITICAL',
      },
    ],
  }

  return new Map([
    ['security/evidence/deadweight-evidence.json', `${JSON.stringify(native, null, 2)}\n`],
    ['security/evidence/modelscan-report.json', `${JSON.stringify(modelscan, null, 2)}\n`],
  ])
}

/* -------------------------------------------------------------------------- */

const check = process.argv.includes('--check')
const binary = fixtures()
const documents = evidenceDocuments(binary)
const all = new Map<string, Uint8Array>()
for (const [path, data] of binary) all.set(join('demo-project', path), data)
for (const [path, body] of documents) {
  all.set(join('demo-project', path), new TextEncoder().encode(body))
}
for (const [path, data] of malformed()) all.set(join('malformed', path), data)

let failures = 0

for (const [relative, data] of all) {
  const target = join(FIXTURES, relative)
  if (check) {
    try {
      const existing = new Uint8Array(await readFile(target))
      const same = existing.length === data.length && existing.every((byte, i) => byte === data[i])
      if (!same) {
        console.error(`::error::${relative} differs from the generator output.`)
        failures += 1
      }
    } catch {
      console.error(`::error::${relative} is missing.`)
      failures += 1
    }
    continue
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
}

if (check) {
  if (failures > 0) {
    console.error(`${failures} fixture(s) out of date. Run \`npm run fixtures\`.`)
    process.exit(1)
  }
  console.log(`All ${all.size} generated fixtures match the generator.`)
} else {
  console.log(`Wrote ${all.size} generated fixtures into fixtures/.`)
}
