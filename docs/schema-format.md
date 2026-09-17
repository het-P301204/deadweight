# Schemas

Two documents leave DEADWEIGHT: the **report**, which is everything the
analysis resolved, and the **Model BOM**, which is the inventory derived from
it. Both are canonical JSON — object keys sorted, no insignificant
whitespace — and neither carries a timestamp.

## Why there is no timestamp

Two analyses of the same tree produce byte-identical documents. That is what
makes `deadweight diff` a diff of the project rather than a diff of the run.
A `generatedAt` field would make every diff report every artifact as changed,
which is the same as reporting nothing.

The `digest` field is a SHA-256 over the canonical body, so a document can be
compared without being re-read.

---

## `deadweight.bom/1`

```json
{
  "schema": "deadweight.bom/1",
  "project": "atlas-triage",
  "generator": { "name": "deadweight", "schema": "deadweight.bom/1" },
  "entries": [ … ],
  "summary": { … },
  "digest": "aebf832d…"
}
```

### An entry

```json
{
  "id": "weights/ranker.bin",
  "name": "ranker.bin",
  "version": null,
  "locator": "weights/ranker.bin",
  "origin": "in-tree",

  "format": {
    "id": "pytorch-zip",
    "label": "PyTorch archive",
    "basis": "container",
    "note": "zip archive containing a data.pkl member",
    "extensionMismatch": null
  },

  "digest": { "algorithm": "sha256", "value": "b9767d75…", "coverage": "full" },
  "sizeBytes": 523,

  "load": {
    "behaviour": "unknown",
    "label": "Unknown",
    "mechanism": "What this line does depends on the installed PyTorch version, …",
    "guard": null,
    "guardRemovedBecomes": null,
    "unresolvedReason": "loader-default-unpinned"
  },

  "loadSites": [
    { "file": ".github/scripts/verify_checkpoint.py", "line": 14, "loader": "torch.load", "enclosing": "main" }
  ],

  "contexts": [
    { "environment": "ci", "basis": "declared", "privileged": true, "privileges": ["process-execution"] }
  ],

  "evidence": [
    { "scanner": "modelscan", "version": "0.8.4", "result": "pass", "binding": "stale", "detail": "…" }
  ],

  "alternative": {
    "kind": "sibling-present",
    "targetFormat": "safetensors",
    "summary": "safetensors of the same weights is already in the repository",
    "resultingBehaviour": "data"
  },

  "findings": ["inconsistent-guard", "shadowed-safe-format", "unpinned-loader-default"]
}
```

### Field notes

**`origin`** — `in-tree` (a file in the repository), `remote-reference` (a
repository resolved at run time), or `unresolved` (a path the code loads and
no such file is here).

**`format.basis`** — how the format was decided: `magic` (a signature in the
leading bytes), `container` (the member names inside an archive), `extension`
(the bytes matched nothing, and the verdict is a fallback that says so),
`declared` (a manifest entry), `none`.

**`format.extensionMismatch`** — set when the extension and the bytes
disagree. Non-null is a finding: anything in the pipeline that dispatches on
the extension will disagree with the classification.

**`digest.coverage`** — `full` when every byte was hashed. `head-tail` when
the artifact exceeded the full-hash limit, in which case the digest covers the
head, the tail and the length. Such a digest is stable and detects change, and
is deliberately **not** comparable with a scanner's whole-file hash; evidence
binding treats it as `unbound`.

**`load.behaviour`** — one of `code`, `directive`, `guarded`, `data`,
`unknown`. See [load semantics](load-semantics.md).

**`load.guard`** and **`load.guardRemovedBecomes`** — present when the
behaviour is `guarded`. The first is the flag holding the surface shut; the
second is what the behaviour becomes without it. Recording both is the point
of having a `guarded` state at all.

**`load.unresolvedReason`** — non-null exactly when the behaviour is
`unknown`: `loader-default-unpinned`, `artifact-unresolved`,
`format-undetermined`, `path-not-static`, `remote-contents-unresolvable`,
`loader-unrecognised`, `artifact-unreadable`.

**`contexts[].basis`** — `declared` (a glob in the project configuration),
`inferred` (a path rule or a framework marker), `unresolved`. An
`unresolved` context is never converted to a safe one.

**`evidence[].binding`** — `current`, `stale`, `unbound`. The scanner's own
`result` is a separate axis: a `pass` that is `stale` is still recorded as a
pass, about bytes that are not here.

---

## `deadweight.report/1`

A superset of the BOM. Everything above, plus:

- `records[].behaviour.steps` — the reasoning, as `{ claim, basis }` pairs.
  This is what the drawer's "how that was decided" list renders, and it is the
  part worth reading in a review.
- `records[].loadSites[].behaviour` — the per-site verdict, before the
  most-exposed rule picks the artifact's headline.
- `records[].loadSites[].args` — the call's arguments, with literal values
  where they were literals.
- `records[].artifact.pickle` — the opcode observation: protocol, the globals
  the stream names, which invoking opcodes are present, whether the scan was
  truncated at the byte cap.
- `records[].artifact.tensorHeader` — entry count and metadata for a
  safetensors file.
- `records[].artifact.siblings` — files beside it with the same stem, which is
  how `shadowed-safe-format` is found.
- `records[].stripe` — the six-cell signature, computed once so the diagram,
  the row glyph and the drawer cannot disagree.
- `contexts` — every load context, with its privilege signals and their lines.
- `orphanLoadSites` — load sites whose target could not be resolved.
- `findings` — ranked, with `disposition`, `rationale` and `locations`.
- `dependencies` — what the project declares, with `pin` as `exact`, `range`
  or `unpinned`.
- `notices` — what was skipped and why: over a size limit, unreadable, a
  symbolic link, a notebook that did not parse.
- `counts` — files walked, files read, bytes read.

---

## CycloneDX 1.6 ML-BOM export

A **subset**, labelled as one inside the document itself.

DEADWEIGHT populates component identity, `version`, `hashes`, the component
type, and its own analysis as `deadweight:`-namespaced `properties` — which is
what the specification provides for exactly this case.

It does **not** emit `modelParameters`, `quantitativeAnalysis` or
`considerations`. Those are facts about how a model was trained, and this tool
analyses a repository statically and never opens a model, so it has no basis
for them. Emitting them empty would produce a document that looks complete and
is not.

Component types: `machine-learning-model` for model artifacts, `data` for
skills, agent definitions, prompt templates and MCP manifests. A Markdown file
is not a model.

The namespaced properties carry `format`, `format.basis`, `format.note`,
`load.behaviour`, `load.mechanism`, `load.guard`,
`load.guardRemovedBecomes`, `load.unresolvedReason`, one `loadSite` per site,
one `context` per context, one `evidence` per record — and where there are no
records, an explicit `evidence` property reading
`none recorded; an absent scan is not a clean scan`, because an omitted
property reads as a clean one.

---

## CSV export

One row per artifact. Every field is quoted, embedded quotes are doubled, and
any cell beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is
prefixed with a single quote.

That last rule is not cosmetic. A model path is attacker-influenceable text,
and a spreadsheet evaluates a cell that starts with `=`. Neutralising it is
the difference between an inventory and a delivery mechanism.

---

## Project configuration

`deadweight.yaml`, `deadweight.yml`, `.deadweight.yaml` or `deadweight.json`
at the repository root.

```yaml
environments:
  production:
    - src/serving/**
    - src/agents/**
  build:
    - scripts/**
  ci:
    - .github/scripts/**
  sandbox:
    - examples/**

ignore:
  - vendor/**
```

Declarable environments: `production`, `staging`, `service`, `ci`, `build`,
`notebook`, `test`, `development`, `sandbox`. A declaration beats an inferred
rule, and the product shows that it was a declaration.

The YAML reader is a hand-written two-level parser, not a YAML engine. In a
tool whose entire argument is that deserialising untrusted input is how you
get executed, shipping a deserialiser to read a file from the repository under
analysis would be difficult to defend. It accepts exactly the shape above and
raises on anything else — an unknown section, an unknown environment name, tab
indentation, a list item with no environment above it, or a pattern that is
not repository-relative. It does not skip what it cannot understand, because a
configuration that looks like it declares production but does not is worse
than no configuration.

---

## Evidence documents

DEADWEIGHT reads, from anywhere in the tree:

- `deadweight-evidence.json` and `*.evidence.json` — the native format
- `modelscan*.json` — ModelScan's own report
- `picklescan*.json`, `fickling*.json`

The native format, which is the one to write if you want records that bind:

```json
{
  "schema": "deadweight.evidence/1",
  "records": [
    {
      "scanner": "modelscan",
      "version": "0.8.4",
      "subject": "weights/ranker.bin",
      "sha256": "b9767d75b9062fec…",
      "result": "pass",
      "detail": "No issue reported against the scanner's known-dangerous import list."
    }
  ]
}
```

`result` is one of `pass`, `flagged`, `error`, `skipped`. `sha256` is what
makes the record binding: without it the record is `unbound`, which is
recorded and is not the same as a pass.

<!-- dw:bomentries -->23<!-- /dw --> entries in the demo project's BOM, over
<!-- dw:formats -->15<!-- /dw --> distinct formats.
