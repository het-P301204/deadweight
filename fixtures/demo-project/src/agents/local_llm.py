"""Local summarisation model. Synthetic; see README.md."""

from llama_cpp import Llama

SUMMARISER = "models/tiny-llm.gguf"


def load_summariser():
    """Data only: GGUF is a typed key-value header and tensor buffers."""
    return Llama(model_path=SUMMARISER, n_ctx=2048)


def summarise(text: str) -> str:
    model = load_summariser()
    return model(text, max_tokens=128)["choices"][0]["text"]
