/**
 * A pickle opcode reader that never unpickles.
 *
 * This is the single most important file in DEADWEIGHT's threat model. The
 * product exists to tell you that unpickling a file runs whatever the file
 * says to run, so it must establish that fact about a file without doing it.
 *
 * The reader walks the opcode stream the way `pickletools` does: it reads the
 * one-byte opcode, consumes exactly the argument bytes that opcode declares,
 * and moves on. It maintains no stack, resolves no name, and imports nothing.
 * The only things it takes out of the stream are:
 *
 *   - the protocol version from PROTO,
 *   - the `module name` pairs written by GLOBAL and STACK_GLOBAL,
 *   - whether any callable-invoking opcode is present.
 *
 * Every read is bounds-checked against the buffer, and the walk stops at the
 * opcode and byte caps in limits.ts, because a malformed stream is exactly
 * what an attacker hands to a scanner.
 *
 * Reference: CPython Lib/pickle.py opcode definitions, protocols 0-5.
 */

import { MAX_PICKLE_BYTES, MAX_PICKLE_OPCODES } from './limits.ts'
import type { PickleObservation } from './types.ts'

/**
 * Opcodes whose effect is to call something the stream names.
 *
 * Written as byte values rather than characters because two of them are
 * outside ASCII and comparing decoded strings would depend on the decoder.
 * BUILD is included because it reaches `__setstate__` on an object the stream
 * chose, which is a call the file controls.
 */
const INVOKING_CODES = new Map<number, string>([
  [0x52, 'REDUCE'],
  [0x69, 'INST'],
  [0x6f, 'OBJ'],
  [0x81, 'NEWOBJ'],
  [0x92, 'NEWOBJ_EX'],
  [0x62, 'BUILD'],
])

const ASCII = new TextDecoder('latin1')

interface Cursor {
  readonly data: Uint8Array
  at: number
}

function u8(c: Cursor): number | null {
  if (c.at >= c.data.length) return null
  const v = c.data[c.at] as number
  c.at += 1
  return v
}

function u16(c: Cursor): number | null {
  if (c.at + 2 > c.data.length) return null
  const v = (c.data[c.at] as number) | ((c.data[c.at + 1] as number) << 8)
  c.at += 2
  return v
}

function u32(c: Cursor): number | null {
  if (c.at + 4 > c.data.length) return null
  const v =
    ((c.data[c.at] as number) |
      ((c.data[c.at + 1] as number) << 8) |
      ((c.data[c.at + 2] as number) << 16) |
      ((c.data[c.at + 3] as number) << 24)) >>>
    0
  c.at += 4
  return v
}

function u64(c: Cursor): number | null {
  if (c.at + 8 > c.data.length) return null
  let lo = 0
  let hi = 0
  for (let i = 0; i < 4; i += 1) lo |= (c.data[c.at + i] as number) << (8 * i)
  for (let i = 4; i < 8; i += 1) hi |= (c.data[c.at + i] as number) << (8 * (i - 4))
  c.at += 8
  // Sizes beyond 2^53 are not representable and are not real; treat as overflow.
  return (hi >>> 0) * 0x100000000 + (lo >>> 0)
}

/** Skip `n` bytes; false when the stream is shorter than it claims. */
function skip(c: Cursor, n: number): boolean {
  if (n < 0 || c.at + n > c.data.length) return false
  c.at += n
  return true
}

/** Read a newline-terminated ASCII argument. */
function line(c: Cursor): string | null {
  const start = c.at
  while (c.at < c.data.length && c.data[c.at] !== 0x0a) c.at += 1
  if (c.at >= c.data.length) return null
  const text = ASCII.decode(c.data.subarray(start, c.at))
  c.at += 1
  return text
}

/** Read a length-prefixed byte run and decode it as text. */
function counted(c: Cursor, n: number): string | null {
  if (n < 0 || c.at + n > c.data.length) return null
  const text = ASCII.decode(c.data.subarray(c.at, c.at + n))
  c.at += n
  return text
}

/**
 * True when the buffer plausibly begins a pickle stream.
 *
 * Protocols 2-5 start with PROTO (0x80) and a version byte. Protocols 0 and 1
 * have no framing, so the check falls back to "the first byte is a valid
 * opcode and a short walk does not immediately fail", which is the best any
 * reader can do without executing.
 */
export function looksLikePickle(data: Uint8Array): boolean {
  if (data.length < 2) return false
  if (data[0] === 0x80) {
    const version = data[1] as number
    return version >= 1 && version <= 5
  }
  const first = data[0] as number
  // The opcodes a protocol 0/1 stream realistically opens with.
  const openers = new Set([0x28, 0x7d, 0x5d, 0x29, 0x63, 0x4b, 0x58, 0x55, 0x53, 0x8c, 0x4e])
  if (!openers.has(first)) return false
  const scan = read(data)
  return scan.protocol === null && (scan.globals.length > 0 || scan.invokesCallable)
}

/**
 * Walk the opcode stream. Never throws: a truncated or malformed stream
 * returns what was learned before the failure, with `truncated` set.
 */
export function read(data: Uint8Array): PickleObservation {
  const bounded = data.length > MAX_PICKLE_BYTES ? data.subarray(0, MAX_PICKLE_BYTES) : data
  const c: Cursor = { data: bounded, at: 0 }
  const globals = new Set<string>()
  const invoking = new Set<string>()
  let protocol: number | null = null
  let opcodes = 0
  let truncated = data.length > MAX_PICKLE_BYTES

  // STACK_GLOBAL takes its two names off the stack rather than from the
  // opcode. The reader keeps only the most recent short-string pushes, which
  // is enough to recover `module name` in every stream a real pickler emits
  // and is explicitly best-effort for one that does not.
  let prevString: string | null = null
  let prevPrevString: string | null = null

  const pushString = (s: string | null): void => {
    prevPrevString = prevString
    prevString = s
  }

  while (c.at < bounded.length) {
    if (opcodes >= MAX_PICKLE_OPCODES) {
      truncated = true
      break
    }
    opcodes += 1

    const op = u8(c)
    if (op === null) {
      truncated = true
      break
    }

    const invokes = INVOKING_CODES.get(op)
    if (invokes !== undefined) invoking.add(invokes)

    switch (op) {
      /* framing and terminators ------------------------------------------ */
      case 0x80: {
        // PROTO
        const v = u8(c)
        if (v === null) return done(true)
        protocol = v
        break
      }
      case 0x95: {
        // FRAME
        if (u64(c) === null) return done(true)
        break
      }
      case 0x2e: // STOP
        return done(truncated)

      /* the two opcodes that name a callable ------------------------------ */
      case 0x63: {
        // GLOBAL: module\nname\n
        const mod = line(c)
        const name = mod === null ? null : line(c)
        if (mod === null || name === null) return done(true)
        globals.add(`${mod}.${name}`)
        break
      }
      case 0x93: {
        // STACK_GLOBAL: module and name come off the stack
        if (prevPrevString !== null && prevString !== null) {
          globals.add(`${prevPrevString}.${prevString}`)
        } else {
          globals.add('<stack-global>')
        }
        break
      }
      case 0x82: {
        // EXT1 .. EXT4 name an object through the copyreg extension registry,
        // which resolves to a callable the same way GLOBAL does.
        if (u8(c) === null) return done(true)
        globals.add('<extension-registry>')
        break
      }
      case 0x83: {
        if (u16(c) === null) return done(true)
        globals.add('<extension-registry>')
        break
      }
      case 0x84: {
        if (u32(c) === null) return done(true)
        globals.add('<extension-registry>')
        break
      }

      /* strings, which STACK_GLOBAL reads back ---------------------------- */
      case 0x8c: {
        // SHORT_BINUNICODE
        const n = u8(c)
        if (n === null) return done(true)
        pushString(counted(c, n))
        if (prevString === null) return done(true)
        break
      }
      case 0x58: {
        // BINUNICODE
        const n = u32(c)
        if (n === null) return done(true)
        if (n > bounded.length) return done(true)
        pushString(counted(c, n))
        if (prevString === null) return done(true)
        break
      }
      case 0x8d: {
        // BINUNICODE8
        const n = u64(c)
        if (n === null || n > bounded.length) return done(true)
        pushString(counted(c, n))
        if (prevString === null) return done(true)
        break
      }
      case 0x55: {
        // SHORT_BINSTRING / SHORT_BINBYTES share the layout
        const n = u8(c)
        if (n === null) return done(true)
        pushString(counted(c, n))
        if (prevString === null) return done(true)
        break
      }
      case 0x54: {
        // BINSTRING
        const n = u32(c)
        if (n === null || n > bounded.length) return done(true)
        pushString(counted(c, n))
        if (prevString === null) return done(true)
        break
      }
      case 0x56: // UNICODE
      case 0x53: {
        // STRING
        const s = line(c)
        if (s === null) return done(true)
        pushString(s)
        break
      }
      case 0x42: {
        // BINBYTES
        const n = u32(c)
        if (n === null || !skip(c, n)) return done(true)
        pushString(null)
        break
      }
      case 0x43: {
        // SHORT_BINBYTES
        const n = u8(c)
        if (n === null || !skip(c, n)) return done(true)
        pushString(null)
        break
      }
      case 0x8e: {
        // BINBYTES8
        const n = u64(c)
        if (n === null || !skip(c, n)) return done(true)
        pushString(null)
        break
      }
      case 0x96: {
        // BYTEARRAY8
        const n = u64(c)
        if (n === null || !skip(c, n)) return done(true)
        pushString(null)
        break
      }

      /* numbers and fixed-width arguments --------------------------------- */
      case 0x4a: // BININT
        if (u32(c) === null) return done(true)
        break
      case 0x4b: // BININT1
      case 0x71: // BINPUT
      case 0x68: // BINGET
        if (u8(c) === null) return done(true)
        break
      case 0x4d: // BININT2
        if (u16(c) === null) return done(true)
        break
      case 0x72: // LONG_BINPUT
      case 0x6a: // LONG_BINGET
        if (u32(c) === null) return done(true)
        break
      case 0x47: // BINFLOAT
        if (!skip(c, 8)) return done(true)
        break
      case 0x8a: {
        // LONG1
        const n = u8(c)
        if (n === null || !skip(c, n)) return done(true)
        break
      }
      case 0x8b: {
        // LONG4
        const n = u32(c)
        if (n === null || !skip(c, n)) return done(true)
        break
      }

      /* newline-argument opcodes ------------------------------------------ */
      case 0x49: // INT
      case 0x4c: // LONG
      case 0x46: // FLOAT
      case 0x70: // PUT
      case 0x67: // GET
      case 0x50: // PERSID
        if (line(c) === null) return done(true)
        break

      case 0x69: {
        // INST: module\nclass\n, and it calls the class
        const mod = line(c)
        const name = mod === null ? null : line(c)
        if (mod === null || name === null) return done(true)
        globals.add(`${mod}.${name}`)
        break
      }

      /* zero-argument opcodes -------------------------------------------- */
      default:
        // Everything else -- MARK, EMPTY_DICT, APPEND, SETITEM, TUPLE, POP,
        // DUP, NONE, NEWTRUE, NEWFALSE, REDUCE, BUILD, OBJ, NEWOBJ,
        // NEWOBJ_EX, MEMOIZE, EMPTY_SET, FROZENSET, ADDITEMS, NEXT_BUFFER,
        // READONLY_BUFFER -- carries no inline argument. An unrecognised byte
        // is treated the same way and the walk continues; the reader's job is
        // to notice names and calls, not to validate the stream.
        break
    }
  }

  return done(truncated)

  function done(cut: boolean): PickleObservation {
    return {
      protocol,
      globals: [...globals].sort(),
      invokesCallable: invoking.size > 0,
      invokingOpcodes: [...invoking].sort(),
      truncated: cut,
    }
  }
}

/**
 * Names whose appearance in a pickle stream is worth quoting in a report.
 *
 * This is deliberately *not* a verdict. Presence of `os.system` is a stronger
 * thing to show a reader than presence of `collections.OrderedDict`, but the
 * absence of every name on this list means nothing at all: the reachable
 * gadget set for a pickle is the set of importable callables, which is the
 * whole installed environment. DEADWEIGHT surfaces the names so a human can
 * look, and never lets that lookup change the load behaviour.
 */
const NOTABLE = [
  'os.system',
  'os.popen',
  'os.execv',
  'os.spawnv',
  'posix.system',
  'nt.system',
  'subprocess.Popen',
  'subprocess.run',
  'subprocess.call',
  'subprocess.check_output',
  'builtins.eval',
  'builtins.exec',
  'builtins.compile',
  'builtins.__import__',
  'builtins.getattr',
  'importlib.import_module',
  'runpy._run_code',
  'pty.spawn',
  'socket.socket',
  'shutil.rmtree',
  'webbrowser.open',
  'operator.attrgetter',
  'functools.partial',
]

export function notableGlobals(globals: readonly string[]): readonly string[] {
  return globals.filter((g) => NOTABLE.includes(g))
}
