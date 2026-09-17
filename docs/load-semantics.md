# Load semantics

The reference DEADWEIGHT reasons from. Every `mechanism` string the product
shows comes from one of the entries below, and every rule that depends on a
library version names the release it depends on.

The rule that governs all of it: **the call site decides, then the format.**
`pickle.load` runs the opcode interpreter over whatever bytes it is handed, so
the format of the target cannot make it safe. `torch.load` reads a PyTorch
archive, so the flags on the call are what decide.

---

## `pickle` {#pickle}

**Formats:** bare pickle, PyTorch archives, joblib dumps, `numpy` object
arrays, pandas pickles, `dill` and `cloudpickle` streams.

Unpickling is an interpreter for a stack language. Its `REDUCE`, `INST`, `OBJ`,
`NEWOBJ` and `NEWOBJ_EX` opcodes call objects the stream names by module and
attribute; `BUILD` reaches `__setstate__` on an object the stream chose. The
callable is resolved by import at unpickle time. Reading the file is running
it.

There is no safe mode. CPython's `pickle` has no flag that restricts which
objects a stream may name, which is why every loader in this family is
classified `code` regardless of the file it is pointed at.

**What DEADWEIGHT does instead of unpickling.** It walks the opcode stream:
reads the one-byte opcode, consumes exactly the argument bytes that opcode
declares, and moves on. It keeps no stack, resolves no name and imports
nothing. What it takes out is the protocol version, the `module.name` pairs
written by `GLOBAL` and `STACK_GLOBAL`, and whether any callable-invoking
opcode is present. See `src/engine/pickle.ts`.

**Why the names it finds never change the verdict.** The reachable gadget set
for a pickle is every importable callable in the environment that unpickles
it. A stream that names only `collections.OrderedDict` is not therefore safe;
it is a stream whose first hop is boring. DEADWEIGHT shows the names because a
human should look, and refuses to let that lookup move the classification.

---

## `torch.load` {#torch-load}

**Depends on:** the pinned `torch` version, and the `weights_only` argument.

`torch.load` unpickles. Until PyTorch 2.6 it did so without restriction, so
every call was an arbitrary code execution primitive. From 2.6 the
`weights_only` argument defaults to `True`, which selects a restricted
unpickler that refuses globals outside an allowlist.

| At the call site | Resolved torch | DEADWEIGHT says |
| --- | --- | --- |
| `weights_only=False` | any | `code` |
| `weights_only=True` | any | `guarded`, guard `weights_only=True` |
| `pickle_module=…` | any | `code` — the argument replaces the unpickler |
| nothing | pinned `< 2.6` | `code` |
| nothing | pinned `>= 2.6`, or a floor at or above it | `guarded` |
| nothing | unpinned, or a range spanning 2.6 | `unknown`, reason `loader-default-unpinned` |

The last row is the reason this product exists. `torch>=2.0` in a requirements
file permits versions on both sides of the change, so the same line of code is
either a restricted read or a remote code execution primitive depending on
what the environment resolved to. DEADWEIGHT will not pick one.

**`guarded` is not `data`.** The restricted unpickler is an allowlist, not a
sandbox. It stops the archive naming arbitrary callables; it is one keyword
argument, or one version bump, away from not being there. Converting the
artifact to safetensors removes the surface instead of suppressing it.

---

## `torch.jit.load` {#torchscript}

A TorchScript archive carries a serialised *program* alongside the weights: a
`code/` tree of TorchScript IR and a constants pickle. Loading deserialises
code for the TorchScript interpreter to run. `weights_only` is not an argument
to this function and has no effect here. Always `code`.

---

## `torch.hub.load`, `datasets.load_dataset(trust_remote_code=True)` {#remote-code}

The execution surface is not a serialisation format. `torch.hub.load` fetches
a repository and imports its `hubconf.py` to build the model;
`trust_remote_code` permits a dataset repository to ship a loading script
that runs in your process.

DEADWEIGHT makes no network requests, so what those repositories contain is
outside the analysis. What it can say is that the trust is placed in whatever
they contain at the moment of the call, and that nothing in the project pins
it.

---

## `numpy.load` {#numpy-load}

`.npy` is an ASCII header and a contiguous buffer; `.npz` is a zip of those.
Neither carries an execution surface **unless** the declared dtype is
`object`, which stores the elements as a pickle.

`allow_pickle` has defaulted to `False` since NumPy 1.16.3. So:
`allow_pickle=True` is `code`; anything else is `data`, and an explicit
`allow_pickle=False` is recorded as a guard.

DEADWEIGHT reads the `.npy` header and reports when a file declares an object
dtype, because such a file will raise under the default rather than load — a
correctness problem worth seeing next to the security one.

---

## `keras.models.load_model` {#keras-load-model}

**Depends on:** the pinned `keras` version, or `tensorflow` when keras is not
declared separately, and the `safe_mode` argument.

Loading a Keras model rebuilds it from its stored configuration. A `Lambda`
layer's configuration is marshalled Python bytecode, so rebuilding one
executes code the file supplies. Keras 3 defaults `safe_mode` to `True` and
refuses that; Keras 2, which TensorFlow bundled before 2.16, deserialises it.

| At the call site | Resolved keras / tensorflow | DEADWEIGHT says |
| --- | --- | --- |
| `safe_mode=False` | any | `code` |
| `safe_mode=True` | any | `guarded` |
| nothing | keras `>= 3`, or tensorflow `>= 2.16` | `guarded` |
| nothing | keras `2.x`, or tensorflow `< 2.16` | `code` |
| nothing | neither pinned | `unknown`, reason `loader-default-unpinned` |

The weights in a `.h5` are data. It is the architecture reconstruction that
carries the surface, which is why the format's `intrinsic` is `code` and not
the other way round.

---

## `tf.saved_model.load` {#savedmodel}

A SavedModel restores a graph and its concrete functions. The graph can
contain operations with side effects, including file and network operations,
which run when a restored function is called. Always `code`.

---

## `from_pretrained` {#from-pretrained}

**Covers:** `transformers` auto classes, `transformers.pipeline`,
`sentence_transformers.SentenceTransformer`, and the `transformers.js`
equivalents.

| At the call site | DEADWEIGHT says |
| --- | --- |
| `trust_remote_code=True` | `code` — repository Python is imported into this process |
| `use_safetensors=True` | `data` — the loader refuses a repository that offers only pickle-backed weights |
| resolves to a file in the tree | the resolved format decides, with the torch rules applied |
| a remote reference, nothing else | `unknown`, reason `remote-contents-unresolvable` |

The last row is deliberate. Without `use_safetensors` the library *prefers*
safetensors and falls back to pickle-backed weights, so the answer depends on
which files that repository serves. DEADWEIGHT does not fetch, so it does not
know. Passing `use_safetensors=True` makes the format a requirement rather
than a preference, and the answer becomes knowable from the code alone.

`transformers.js` has no equivalent of `trust_remote_code`: it runs ONNX
through onnxruntime and cannot import repository Python.

---

## `safetensors` {#safetensors}

A `u64` little-endian header length, that many bytes of JSON naming dtype,
shape and byte range per tensor, then the raw buffers. There is no instruction
in the file to interpret, so deserialising cannot call anything.

Two honest qualifications. It carries **weights only**, not the model
architecture — so a migration to safetensors is only complete if your code,
not the checkpoint, defines the model. And DEADWEIGHT parses the header under
a size cap with the declared length validated against the file, because a
header claiming to be four gigabytes is a thing a file can claim.

---

## `onnxruntime.InferenceSession` {#onnx}

Parsing an ONNX file builds an operator graph from a protobuf. Nothing in the
file is executed to do that, so the parse is `data`.

The qualification that belongs next to it: the runtime then *executes* that
graph, and a graph referencing a custom operator will load the shared library
that implements it. Custom operators have to be registered by the host, which
is the boundary — but it is a boundary, not an absence.

---

## GGUF, TFLite, Flax msgpack {#gguf}

GGUF is a typed key-value header followed by tensor buffers; TFLite is a
FlatBuffer read in place; a Flax checkpoint is a msgpack parameter tree. None
of the three names a callable anywhere in the format. All `data`.

---

## Agent skills, agent definitions, prompt templates

These execute nothing and are still not `data`.

Loading a skill places its text into a model context as instructions.
Loading an agent definition registers a system prompt and a tool grant.
Interpolating a prompt template produces instruction text. In each case the
artifact's purpose is to make something else act, so reporting "no code runs"
would be true and misleading.

DEADWEIGHT classifies them `directive`, records the tool grant verbatim, and
notes the executables a skill body points at — because an instruction that
says "run `scripts/collect.py`" is the beginning of an execution path even
though loading the instruction is not.

There is no safe serialisation format to migrate to, because the surface is
not serialisation. What bounds it is the grant and the review the file gets
before it lands.

---

## MCP server manifests

Two different answers from one file shape.

A **stdio** entry names a command the client spawns when the session starts.
Reading the manifest is what causes that process to run — before any tool is
called and before the model has decided anything. What the process does is
determined by whatever the package resolves to at that moment, which no pin in
the analysed project constrains. `code`.

A **remote** entry names an endpoint. Nothing is spawned locally; the tool
names and descriptions the server returns become instructions in the model
context. `directive`, and DEADWEIGHT does not contact the endpoint, so what it
would return is outside the analysis.

Hook commands in an agent settings file are the same shape as the stdio case:
reading the file registers a shell command the host runs on an event. `code`.

---

## Formats DEADWEIGHT recognises but has no loader rule for

An artifact in the tree that nothing in the tree loads still gets a format
verdict, because the format is what says what loading it *would* do. Its load
stage is marked unresolved, and where the format carries an execution surface
the behaviour is `unknown` rather than `code`: which loader reads it, and with
which flags, is decided by a call site that is not in this repository.
