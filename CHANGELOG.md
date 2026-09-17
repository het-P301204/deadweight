# Changelog

## 0.1.0

First release. DEADWEIGHT analyses a codebase and answers one question about
every AI artifact it loads: what happens when it is loaded?

### The analysis

- **Seven-stage pipeline** — artifact, format, load site, load behaviour,
  context, evidence, alternative — with each stage resolvable independently
  and `unknown` a first-class outcome carrying a reason.
- **Format recognition from bytes**, never from loading: magic numbers, zip
  central-directory member names, length-prefixed headers, and a pickle
  opcode reader written from scratch that walks the stream and constructs
  nothing. 21 formats.
- **24 loader rules** across Python, JavaScript, TypeScript and Jupyter
  notebooks, with behaviour resolved against the versions the project
  declares. `torch.load`, `keras.models.load_model`, `numpy.load` and
  `from_pretrained` are version- or flag-dependent and are reported as
  `unknown` when the declaration does not settle them.
- **Per-site behaviour.** One artifact loaded two ways takes the more exposed
  verdict, and the disagreement is itself a finding.
- **Skills, agents, MCP manifests, hooks and prompt templates** as
  first-class artifacts. A stdio MCP entry spawns a process when the manifest
  is read, which is `code`; a skill injects instructions, which is
  `directive` — reported separately because "no code runs" is a misleading
  summary of a file whose purpose is to make something else run.
- **Context as a separate axis** — declared, inferred or unresolved, and the
  product says which — crossed with behaviour in a matrix rather than
  combined into a score.
- **Privilege signals** read from the loading file, with the line that
  matched.
- **Evidence bound to digests.** A scanner result about bytes that have moved
  is stale, not passing, and no evidence state ever changes a load behaviour.
  Scanner coverage statements are shown beside every result.
- **Safe-format resolution** three ways: a data-only sibling already in the
  repository, a guard available at the call site, or a conversion — each with
  its security difference and its caveat.

### The outputs

- **Model BOM** in a documented native schema, plus a CycloneDX 1.6 ML-BOM
  subset that states inside itself which fields it does not populate and why,
  plus CSV with formula-injection neutralised.
- **BOM diff** field by field, saying whether each change opened or closed an
  execution surface.
- **No timestamps anywhere.** Two analyses of the same tree produce
  byte-identical documents, which is what makes a diff a diff of the project.

### The interfaces

- **CLI** that runs the engine's TypeScript sources directly under Node 24's
  native type stripping: no build step, no dependencies. Exit codes 0 / 1 / 2
  with a `--fail-on` threshold.
- **Web interface** that runs the identical engine in the tab over a folder
  you pick or drop. Nothing leaves the page: no network API in the bundle,
  every font bundled, `connect-src 'none'` in the policy.
- **Demo mode** that analyses a bundled synthetic project through the real
  engine rather than replaying a fixture of results.

### The design

- The **load stripe**: six cells, one per stage, at three scales — the
  full-size boundary diagram on the overview, an inline glyph in every row,
  a traced path in the drawer. Computed once in the engine so the three
  cannot disagree.
- Six views, one investigation drawer, a command palette on ⌘K, `/` to search,
  arrow keys to walk rows.
- Dark and light as two specifications rather than one inverted, and
  `prefers-reduced-motion` reducing motion to a cross-fade rather than
  removing the state change.

### Hardening

Found by an adversarial pass over the untrusted-input paths before the first
release, and each one now has a regression test.

- **Denial of service through a long line.** The expression that found call
  sites, `/([A-Za-z_][\w.]*)[ \t]*\(/g`, backtracked quadratically over runs
  of name characters: 69 ms for a 10,000-character line, 17 s at 160,000, and
  roughly three quarters of an hour for the 2 MB line that `MAX_SOURCE_BYTES`
  permits. One minified bundle committed to a repository was enough to hang
  the analyser on that repository. Call finding is now a linear scan that
  locates the bracket and walks backwards over the name, checked against the
  expression it replaced on 28 inputs.
- **Denial of service through many load sites.** Resolving a reference
  scanned every path in the tree and materialised the key list to do it, and
  the same reference was resolved twice — once to discover artifacts, once to
  bind sites. 7.9 s for sixteen thousand sites, 51 s for forty thousand. Now
  bucketed by final path segment and memoised: 0.65 s and 1.7 s.
- **Sibling lookup walked the whole tree per artifact.** Now indexed by
  directory and stem.
- **A malformed BOM reached `diffBoms` and produced a TypeError message.**
  `{"entries":[null]}` printed `Cannot read properties of null (reading
  'id')`. Every field the differ reads is now checked, and the failure is the
  same four-part guidance as every other refusal, naming the entry and field.
  A size bound was added to match every other read in the project.
- **Three literal control characters were embedded in source.** `FILLER` was
  a raw U+0001, so the line read `FILLER = ''` and looked like an empty
  string; the NUL check in the path normaliser was a raw NUL, which made the
  file *binary* to `git`, `grep` and GitHub's blob viewer; and the
  malformed-corpus test embedded NUL and escape bytes in a character class.
  All are built from code points now, and a test walks every source file to
  keep it that way.

### Verification

<!-- dw:tests -->296<!-- /dw --> tests across the engine and the design
tokens. <!-- dw:ciasserts -->14<!-- /dw --> of CI's
<!-- dw:cisteps -->21<!-- /dw --> steps assert the product's claims rather
than only that it builds: no clock or randomness in the engine, an identical
digest across two runs, no network API in the bundle, no browser global in
the engine, no deserialising call in the analysis path, every generated
artifact matching its generator, every loader rule resolving to a documented
section, a deliberately hostile tree analysing inside a time budget, a
malformed BOM getting guidance rather than a stack trace, and the exit codes
behaving as documented.
