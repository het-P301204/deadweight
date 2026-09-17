# Security model

DEADWEIGHT is pointed at code it did not write, in a directory handed to it by
someone who may not have looked inside. Security matters in both directions:
the analyser must not be compromised by what it analyses, and the analysis
must not leak what it read.

## Threat model

**Trusted:** the person running the tool, the Node runtime or browser, and
this repository's own source.

**Untrusted, and treated as input:** every byte of the analysed project. File
contents, file *names*, directory structure, manifest and lockfile contents,
the project's `deadweight.yaml`, and any scanner evidence document found in
the tree. All of it is attacker-influenceable if an attacker can land a
commit or ship a package.

**Out of scope:** DEADWEIGHT has no accounts, no server, no database and no
network client. There is no authentication to bypass and no session to steal.
If you deploy the web build, its security posture is your host's.

## The central guarantee

**DEADWEIGHT never deserialises an artifact in order to inspect it.**

The product exists to say that unpickling a file runs whatever the file says
to run, so it establishes that fact without doing it.

- Format recognition reads a bounded prefix (64 KiB) and, for archives, a
  bounded suffix. It matches magic numbers, parses length-prefixed headers,
  and lists zip central-directory member names.
- The pickle reader (`src/engine/pickle.ts`) walks the opcode stream: it reads
  the opcode, consumes exactly the argument bytes that opcode declares, and
  moves on. It maintains no stack, resolves no name, and imports nothing.
- Nothing decompresses. A compressed joblib dump is recognised by its wrapper
  and deliberately left alone.
- No allocation is ever sized by a field in the file. Every declared length is
  validated against the bytes actually in hand.

Enforced three ways: the readers are written that way, `eslint` forbids
browser and network globals in the engine, and CI greps the analysis path for
any deserialising call.

## Bounded reads

Every limit is declared in one file, `src/engine/limits.ts`, so this document
can point at it rather than paraphrase it.

| Limit | Value | Why |
| --- | --- | --- |
| Path length | 1 KiB | A path is input. |
| Walk depth | 24 | Symlink and junction loops. |
| Tree entries | 40 000 | An unbounded walk on an unfamiliar tree is how an analyser becomes the incident. |
| Source file | 2 MiB | Generated and minified files are not source. |
| Notebook | 8 MiB | Notebooks carry base64 outputs. Outputs are never read. |
| Manifest / evidence | 4 MiB | |
| Artifact head / tail | 64 KiB each | Enough to recognise; far short of loading. |
| Full-file digest | 256 MiB | Above it the digest covers head, tail and length, and is labelled `head-tail`. |
| Pickle opcodes | 20 000 | A malformed stream is exactly what an attacker hands a scanner. |
| Pickle bytes | 1 MiB | |
| safetensors header | 16 MiB | The format has no limit; memory does. |
| Zip entries | 4096 | |
| Line length | 4000 | |
| Lines per file | 60 000 | |

### Bounds are necessary and not sufficient

A limit caps how much input reaches the analysis. It says nothing about how
much *work* that input can cause, and the gap between the two is where the
real denial of service lived.

A 2 MB source file is inside the limit above, so it gets read. When the whole
file is one line — a minified bundle, which is an ordinary thing to find in a
repository — the expression that used to find call sites backtracked
quadratically over the run of name characters: measured at 69 ms for a
10,000-character line, 17 s at 160,000, and roughly three quarters of an hour
at 2 MB. Two more scans were quadratic in the same way: resolving a load
target walked every path in the tree, and sibling lookup walked it again per
artifact, so forty thousand load sites took 51 seconds.

All three are linear now — the bracket is found first and the name walked
backwards, and both lookups are indexed — and the property is tested rather
than asserted. `src/engine/hostile.test.ts` times nine adversarial trees
against a budget, and CI builds a hostile directory on the runner and fails
if the analysis takes longer than 90 seconds, which is about a hundred times
what it now costs. The rewrite is also checked against the expression it
replaced on 28 inputs, because a rewrite for speed that changes what is found
would be a worse bug than the one it fixed.

## Input handling

**Paths are refused, not repaired.** A path containing `..`, an absolute form,
a Windows drive letter, a UNC prefix or a NUL byte is rejected. Flattening
`a/../../b` silently would make the report describe a file that was never
there. In the Node adapter every read re-derives the absolute path from the
root and refuses anything that escapes it, rather than trusting a path that
came out of a directory listing.

**Symbolic links are listed and not followed**, with a notice. A link pointing
at `/` turns a bounded walk into a walk of the machine.

**Control characters are stripped** from anything that came out of a scanned
file before it reaches a terminal or a report. A filename containing an ANSI
escape or a bidirectional override is a real technique for making a report say
something other than what it found.

**Parsed JSON has prototype-polluting keys dropped at every level**
(`__proto__`, `constructor`, `prototype`), and objects built from parsed
documents are constructed by explicit assignment rather than by spreading a
parse result. Covered by a test that asserts nothing landed on
`Object.prototype`.

**Globs from the analysed repository** compile to regular expressions built
from a small dialect with no backtracking constructs. A catastrophically
backtracking pattern in a config file would be a denial of service against
the tool by the thing it is analysing.

**A file named on the command line is still input.** `deadweight diff` reads
two BOM documents, and checking only that `entries` was an array let
`{"entries":[null]}` through to the differ, which reported `Cannot read
properties of null (reading 'id')`. Every field the differ reads is now
validated and the refusal is the same four-part guidance as every other one,
naming the entry and the field. A tool whose argument is that failures should
say what happened does not get to print a stack-trace message.

**The configuration reader is hand-written.** In a tool whose argument is that
deserialising untrusted input is how you get executed, shipping a YAML engine
to read a file from the repository under analysis would be hard to defend. It
accepts one shape and raises on anything else rather than skipping what it
cannot understand.

**CSV cells beginning with `=`, `+`, `-`, `@`, a tab or a carriage return are
prefixed with an apostrophe.** A model path is attacker-influenceable text and
a spreadsheet evaluates a cell that starts with `=`. Without this the
inventory is a delivery mechanism.

## Nothing leaves the page

The browser build contains no `fetch`, no `XMLHttpRequest`, no
`navigator.sendBeacon`, no `WebSocket` and no `EventSource`. Every font is
bundled; there is no request to any third party on load. A folder you analyse
is read through the File API in the page.

The page ships a Content Security Policy with `default-src 'none'` and
`connect-src 'none'`, so the browser will refuse a request even if a future
change tried to make one. CI fails the build if a network API appears in the
bundle or a remote font appears in the CSS.

`frame-ancestors` is deliberately **absent** from the meta policy: a browser
ignores that directive when it arrives in a meta element, so claiming it there
would be theatre. If you deploy this, set it — along with
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` — as
response headers at the host.

## Determinism

The engine reads no clock and no random source, asserted by the test suite and
by a CI grep. Two analyses of the same tree produce byte-identical canonical
output and the same digest. That is a security property as much as a
convenience one: a BOM diff is only evidence if an unchanged project produces
an unchanged document.

## What the output does not claim

- **Not a malware verdict.** DEADWEIGHT reports surface, not intent. An
  artifact that executes on load is not compromised.
- **Not a statement about the installed environment.** It reads what the
  repository declares. A lockfile is a claim.
- **Not a statement about a remote repository.** It makes no network requests.
- **Not exhaustive.** Static analysis has a horizon. A loader reached through
  a variable, a factory or `getattr` is not found. Absence of a load site is
  not absence of a load.
- **A scanner result is evidence about specific bytes.** It never changes a
  load behaviour, and a result whose digest no longer matches the file is
  reported as stale rather than passing.

## Known weaknesses of this design

Stated because a tool that lists only its strengths is not a security tool.

- **The pickle reader is a static reader.** Static opcode readers and CPython's
  unpickler have disagreed about the same bytes before, and a stream written so
  the two read it differently is a known bypass class for any scanner of this
  design — including this one.
- **Format recognition reads a bounded prefix.** A file crafted so its first
  64 KiB say one thing and its body another will be classified by the prefix.
- **Behaviour resolution trusts declared versions.** A project that declares
  `torch==2.7.0` and installs 2.5.1 gets a `guarded` verdict for a load that
  executes.
- **Privilege signals are pattern matches on a file.** They over-report (a
  client constructed and never used) and under-report (capability reached
  through a helper in another module).
- **Context inference is a path convention.** A project that does not follow
  the conventions gets `unresolved`, which is honest and not useful; declare
  the environments.

## The demo fixtures

`fixtures/demo-project/weights/classifier.pkl` contains a pickle stream that
names `os.system` and carries a `REDUCE` opcode. A detection fixture for a
pickle scanner has to contain the thing being detected; this is the same shape
every pickle-scanning tool keeps in its test corpus.

It is inert. A pickle is data until something unpickles it, DEADWEIGHT never
does, nothing in this repository or in CI passes it to an unpickler, and its
argument string is `echo DEADWEIGHT SYNTHETIC FIXTURE`. It is generated by
`scripts/make-fixtures.ts`, and `fixtures/README.md` says the same thing next
to the files.

## Reporting

This is a portfolio project rather than a supported product, so there is no
embargo process to promise. Open an issue, or an advisory on the repository if
you would rather not post details publicly.
