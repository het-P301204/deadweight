"""Ranking model. Synthetic; see README.md.

The safetensors export of these exact weights is committed next to the .bin,
and this file loads the .bin.
"""

import torch
from fastapi import APIRouter

router = APIRouter()

RANKER = "weights/ranker.bin"


def load_ranker():
    # No weights_only. With `torch>=2.0` in requirements.txt, whether this is
    # a restricted unpickler or an arbitrary one depends on which torch the
    # environment resolved to.
    return torch.load(RANKER, map_location="cpu")


@router.get("/v1/rank")
def rank(query: str) -> list[str]:
    model = load_ranker()
    return model.rank(query)
