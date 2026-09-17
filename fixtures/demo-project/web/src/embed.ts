// Browser-side embeddings. Synthetic; see README.md.

import { AutoModel, AutoTokenizer } from '@huggingface/transformers'

const REPO = 'atlas-internal/intent-router-small'

export async function loadEncoder() {
  // transformers.js runs ONNX through onnxruntime-web. There is no
  // equivalent of trust_remote_code: the library cannot import repo Python.
  return AutoModel.from_pretrained(REPO)
}

export async function loadTokenizer() {
  return AutoTokenizer.from_pretrained(REPO)
}
