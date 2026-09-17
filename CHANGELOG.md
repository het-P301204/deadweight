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

### Verification

<!-- dw:tests -->258<!-- /dw --> tests across the engine and the design
tokens. CI asserts the product's claims rather than only that it
builds: no clock or randomness in the engine, an identical digest across two
runs, no network API in the bundle, no browser global in the engine, no
deserialising call in the analysis path, every generated artifact matching
its generator, every loader rule resolving to a documented section, and the
exit codes behaving as documented.
