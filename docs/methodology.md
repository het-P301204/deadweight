# Methodology

How DEADWEIGHT reaches its answers, and where it stops.

## The question

> What happens when this AI artifact is loaded?

Seven parts, resolved independently:

```
ARTIFACT -> FORMAT -> LOAD SITE -> LOAD BEHAVIOUR -> CONTEXT -> EVIDENCE -> ALTERNATIVE
```

Each part can come back unresolved, and when one does the others are not
adjusted to compensate. There is no severity score anywhere in the product,
because the two dimensions that matter — what loading does, and where it
happens — are not commensurable. A pickle in a throwaway notebook and the same
pickle in a request handler holding cloud credentials are one execution
surface reached from two very different places. Averaging them is how a real
finding gets buried under nine harmless ones.

## The eight stages

| Stage | What it does |
| --- | --- |
| `walk` | Lists the files in scope. Symbolic links are listed and not followed; the skip list, depth limit and entry limit are enforced during the walk, not after it. |
| `dependencies` | Reads what the project declares: `requirements*.txt`, `constraints*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`, `environment.yml`, `package.json`. Lockfiles win over ranges. |
| `load-sites` | Scans Python, JavaScript, TypeScript and notebook sources for calls that turn an artifact into a live object. |
| `artifacts` | Recognises each artifact from its bytes. Never loads one. |
| `behaviour` | Resolves what loading does at each site, then takes the most exposed of them as the artifact's verdict. |
| `context` | Classifies where each load happens, and what the loading file can reach. |
| `evidence` | Reads scanner reports and binds each record to an artifact digest. |
| `bom` | Assembles the inventory and derives the findings. |

Every stage reports the count it actually produced. There is no percentage,
because there is no honest one: the work per stage depends on what the tree
turns out to contain.

## Recognition without loading

This is the constraint the whole product is built around, and it is enforced
in three places: the readers, the lint rules, and CI.

**What the classifier reads.** The first 64 KiB, and for archives the last
64 KiB. From that it matches magic numbers (`GGUF`, the HDF5 superblock, the
`TFL3` FlatBuffer identifier, `\x93NUMPY`), reads length-prefixed headers
(safetensors), and lists zip central-directory member names. A `.bin` holding
`archive/data.pkl` is a PyTorch archive; a `.safetensors` whose first bytes
are `PK` is a finding.

**What it never does.** It calls no deserialiser, decompresses nothing, and
never allocates a buffer sized by a field in the file. The pickle reader walks
opcodes and constructs nothing (see [load semantics](load-semantics.md#pickle)).
A compressed joblib dump is recognised by its wrapper and explicitly not
decompressed to look inside.

**Why bytes beat extensions.** Anything downstream that dispatches on the
extension will disagree with a file whose contents say otherwise, and that
disagreement is worth a finding on its own.

## Resolving a load target

The scanners work on a *masked* copy of the source: identical in length, with
the inside of every comment and string literal replaced by filler. Bracket
matching then cannot be fooled by punctuation inside a string, a
commented-out loader never becomes a load site, and `name = "torch.load(x)"`
is a string.

Import aliases are reconstructed, so `import torch as T; T.load(p)` and
`from torch import load as tload; tload(p)` both resolve to `torch.load`.

A path expression resolves through the shapes real loading code uses: a
literal, a module constant, `os.path.join`, `pathlib` composition, `+`
concatenation, an f-string whose placeholders are themselves resolvable, and a
file handle traced back to the path it was opened on — including
`with open(path, "rb") as handle` bound per statement rather than per file, so
two handles with the same name in two functions resolve to two different
files.

Everything else is unresolved, and stays unresolved. A load site whose target
is built at run time is reported with the expression as written.

## Behaviour, per site

Behaviour is resolved **per load site**, not per artifact, because one
checkpoint is routinely loaded with `weights_only=True` in a request handler
and without it in a CI script. The artifact's headline verdict is the most
exposed of its sites — `code` over `unknown` over `directive` over `guarded`
over `data` — and the disagreement is itself a finding, because "loaded
safely" is not true of a file that is also loaded unsafely.

The rules are in [load semantics](load-semantics.md). The five states:

- **`code`** — loading runs code in the loading process.
- **`directive`** — loading injects attacker-influenceable instructions into a
  model context. Nothing runs at load; the artifact's purpose is to make
  something else run.
- **`guarded`** — the format carries an execution surface and a documented
  restriction at the call site is suppressing it. Safe only while that flag
  holds, and the entry records what removing it would do.
- **`data`** — no execution or instruction surface in the format.
- **`unknown`** — with a reason code, never silently converted to either.

## Context, and why it is often declared

DEADWEIGHT can see that a file constructs a FastAPI app. It cannot see whether
that app is deployed, or with what credentials. So context is either
**declared** in `deadweight.yaml`, **inferred** from a path rule or a
framework marker, or **unresolved** — and the product always shows which of
the three it was.

Path rules cover CI definitions, build and packaging files, notebooks, tests,
example and scratch directories, and agent runtime configuration. A framework
marker (`fastapi`, `flask`, `django`, `uvicorn`, `ray.serve`, `bentoml`,
`torchserve`, a Lambda handler, `celery`, and others) makes a file a
long-running request handler, which is reported as `service` rather than
`production`: it is an inference about the code, not a claim about a
deployment.

An ordinary source path that nothing covers comes back **unresolved**. That is
deliberate. Calling it `development` would put a quiet label on what might be
a production load.

**Privilege signals** are read as *capability in the same file as the load*:
cloud SDK clients, named secrets read from the environment, secret manager
calls, orchestration APIs, datastore writes, subprocess execution, outbound
HTTP, filesystem writes outside a temporary directory. Each carries its
`file:line` and the matched line. The claim is that the process performing the
load has that reach — not that the artifact uses it.

## Evidence, not assurance

A scanner result is a fact about specific bytes, produced by a tool with a
specific reach. Two disciplines make that operational rather than rhetorical.

**Binding.** Every record is tied to the digest of the artifact it claims to
be about.

| Binding | Meaning |
| --- | --- |
| `current` | The record names a digest and it is the file on disk. |
| `stale` | The record names a digest that is *not* the file on disk. It is evidence about bytes that are no longer here. |
| `unbound` | The record names no digest, or the artifact exceeded the full-hash limit so DEADWEIGHT holds a head-and-tail digest that is deliberately not comparable with a scanner's whole-file hash. |
| `absent` | No record at all. An absent scan is not a clean scan. |

A subject path is matched exactly, then by suffix, then by filename — because
a scanner usually ran from a different working directory. A filename that
matches more than one artifact is left unbound: a record attached to the wrong
file is worse than a record attached to nothing.

**Coverage.** Each scanner has a profile naming what it inspects and the
classes of thing it cannot see, and those limitations are shown next to every
result rather than in a footnote. DEADWEIGHT reads ModelScan and picklescan
reports, its own evidence documents, and records anything else it finds under
a profile that says plainly that it knows nothing about that tool.

**No evidence state ever changes a load behaviour.** A clean ModelScan run on
a pickle-backed checkpoint does not make `torch.load` stop unpickling. This is
asserted by a test, not only by a paragraph.

## Findings

A finding names a state worth a decision, says why it matters, and points at
the lines that establish it. `disposition` is how to act, not how bad it is:

- **act** — a concrete change is available now.
- **review** — a human has to decide something the tool cannot.
- **record** — true, worth having in the inventory, no action implied.

The kinds are `execution-surface`, `privileged-execution-surface`,
`unpinned-loader-default`, `remote-code-trust`, `spawns-process-on-load`,
`directive-surface`, `inconsistent-guard`, `shadowed-safe-format`,
`format-migration-available`, `evidence-stale`, `evidence-absent`,
`unresolved-artifact`, `unresolved-context` and `extension-mismatch`.

## Determinism

The engine reads no clock and no random source. Two analyses of the same tree
produce byte-identical canonical output and the same digest, which is what
makes a BOM diff a diff of the project rather than a diff of the run. CI
asserts both: it greps for clock and randomness use, and it hashes two runs
and compares.

## What it can confirm, and what it cannot

**Can:**

- The format, from the bytes on disk, with the basis recorded.
- That a given line of source calls a given loader on it.
- What that call does with those bytes, given the versions the repository
  declares.
- Whether a data-oriented alternative exists in the repository, at the call
  site, or by conversion.
- Whether a recorded scanner result is still about the bytes that are there.

**Cannot:**

- Whether an artifact is malicious. It reports surface, not intent.
- What a remote repository serves. It makes no network requests.
- Which version is actually installed. A lockfile is a claim, not an
  environment.
- Whether a declared environment is the one the code is deployed to.
- That an unresolved load site is harmless. It is unresolved.

<!-- dw:artifacts -->23<!-- /dw --> artifacts, <!-- dw:loadsites -->32<!-- /dw --> load sites and
<!-- dw:findings -->42<!-- /dw --> findings in the bundled demo project, produced by the pipeline
above with nothing loaded.
