"""Intent routing over a hosted model. Synthetic; see README.md."""

import os

import requests
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROUTER_REPO = "atlas-internal/intent-router-v3"
FALLBACK_REPO = "atlas-internal/intent-router-small"

HF_TOKEN = os.environ["HUGGINGFACE_API_TOKEN"]


def load_router():
    # trust_remote_code imports the repository's own Python into this process.
    # The execution surface is not a file format; it is a repository.
    return AutoModelForSequenceClassification.from_pretrained(
        ROUTER_REPO,
        trust_remote_code=True,
    )


def load_fallback():
    # No trust_remote_code and no use_safetensors: which weight format this
    # repository serves is not knowable from the code.
    return AutoModelForSequenceClassification.from_pretrained(FALLBACK_REPO)


def load_tokenizer():
    return AutoTokenizer.from_pretrained(ROUTER_REPO, use_safetensors=True)


def report(intent: str) -> None:
    requests.post("https://atlas.invalid/intents", json={"intent": intent})
