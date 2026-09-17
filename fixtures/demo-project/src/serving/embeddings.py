"""Sentence embeddings. Synthetic; see README.md."""

from fastapi import APIRouter
from safetensors.torch import load_file

router = APIRouter()

ENCODER = "models/encoder.safetensors"


def load_encoder():
    """Data only: a JSON header of tensor offsets and the buffers behind it."""
    return load_file(ENCODER)


@router.post("/v1/embed")
def embed(text: str) -> list[float]:
    weights = load_encoder()
    return weights["embeddings.weight"][0].tolist()
