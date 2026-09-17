# Contributing

## Setup

Node 24 or newer, for the CLI's native type stripping.

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

## Where things go

```
src/engine/     the analysis. No filesystem, no DOM, no network, no clock.
src/adapters/   node:fs, the browser File API, the bundled demo
src/ui/         primitives, the stripe, the diagrams
src/views/      the six views and the drawer
bin/            the CLI
scripts/        generators, each with a --check mode
fixtures/       the synthetic demo project and the malformed corpus
docs/           load semantics, methodology, schemas
```

Four rules about `src/engine`, enforced by lint and by CI:

1. **No browser globals and no `node:fs`.** The engine runs unchanged under
   Node and in a tab. It is handed a `SourceTree`; it never opens a file.
2. **No clock, no randomness.** Two analyses of the same tree must produce the
   same digest.
3. **No `enum`, no `namespace`, no constructor parameter properties.** The CLI
   runs these sources under Node's type stripping, which cannot emit the
   runtime objects those constructs need. Import specifiers carry their real
   `.ts` extension and type-only imports are marked `import type`.
4. **Nothing deserialises an artifact.** `JSON.parse` is permitted in the
   readers for documents DEADWEIGHT reads on purpose — manifests, lockfiles,
   notebooks, evidence, its own configuration — and nowhere else.

## Adding a loader rule

The most common change. Four steps, in this order:

1. **Document the semantics first**, in `docs/load-semantics.md`, with a
   `{#anchor}`. If the behaviour depends on a library version, name the
   release it changed at and say what it was before and after. If you cannot
   write that paragraph, the rule is not ready.
2. **Add the rule** to `src/engine/loaders.ts`: the canonical dotted-name
   patterns, which argument holds the artifact, and `reference` set to your
   anchor. CI fails if the anchor does not resolve.
3. **Add the behaviour** in `src/engine/behaviour.ts`. Every verdict carries a
   `mechanism` sentence and `steps` with a `basis` for each claim — a file and
   line, a pinned version, a format property, or a named piece of
   documentation. A step with no basis is an opinion.
4. **Add a test** in `src/engine/behaviour.test.ts`, including the unresolved
   case. A version-dependent rule needs three: pinned below, pinned at or
   above, and unpinned.

Add the bare callable name to `BARE_NAMES` if it is new, or the scanners will
skip the call before they ever try to resolve it.

## The four states, and when to use which

| | |
| --- | --- |
| `code` | Loading runs code in the loading process. |
| `directive` | Loading injects instructions into a model context. Nothing runs at load; the artifact exists to make something else run. |
| `guarded` | The format carries an execution surface and a documented restriction at the call site is suppressing it. Record the flag and what removing it would do. |
| `data` | The format has no execution or instruction surface. |
| `unknown` | With a reason code. |

Reach for `unknown` freely. It is not a failure state; it is the whole reason
the product is worth using rather than a denylist. Two things it must never
be: silently converted to `data`, or reported without a reason.

Do not add a severity score. Load behaviour and load context are orthogonal
and are reported as a coordinate. Every review of this project will push back
on a change that combines them.

## Generated artifacts

Four things are generated, committed, and verified by CI rather than trusted:

```bash
npm run fixtures      # the binary demo fixtures and the malformed corpus
npm run demo-tree     # the browser-bundled demo project
npm run error-pages   # 403/404/500 from one template
npm run docs-numbers  # every figure in the README and docs
```

Each has `--check`. Run all four before opening a pull request, or CI will.
`docs-numbers` in particular: never type a number about the demo project into
prose. Wrap it in a `<!-- dw:key -->` marker and add the key to the script.

## Adding a malformed fixture

`fixtures/malformed/` is walked by the test suite rather than listed, so
adding a file adds a test. Add it to `malformed()` in
`scripts/make-fixtures.ts`, run `npm run fixtures`, and note what it
demonstrates in `fixtures/README.md`.

If the new fixture should *raise* rather than be survived — a configuration,
for instance — add its expectation to the table in `malformed.test.ts`. The
test asserts that every config fixture has one.

## Design

Read `src/ui/tokens.ts` before writing a component. State colour has to mean
the same thing in the stripe, the badge, the graph node, the matrix cell and
the diff row; a component that picks its own red breaks the reading of every
dense table in the product.

- **One accent.** Neutral is structure, the blue is information, and the four
  semantic hues are state and nothing else.
- **The stripe is computed once**, in `src/engine/stripe.ts`, so the diagram,
  the row glyph and the drawer cannot disagree. "The stripe is wrong" should
  be a test failure, not a CSS argument.
- **Animate state, relationship, flow or discovery.** Nothing else. Under
  `prefers-reduced-motion` motion becomes a fast cross-fade rather than
  vanishing, so the same change is still announced.
- **Never use a transform for both layout and animation** on one element. The
  entrance keyframes end at `transform: none`, which silently drops a
  centring translate. Use a wrapper.

## Commits

Present tense, one change per commit, and say why rather than what. `git log`
should read as an argument for the current design.
