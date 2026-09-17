"""Segmentation. Synthetic; see README.md."""

import os
from pathlib import Path

import torch

MODEL_ROOT = Path(os.environ.get("ATLAS_MODEL_ROOT", "models"))


def load_segmenter():
    """TorchScript: the archive carries a program, not only weights."""
    return torch.jit.load("models/segmenter.ts.pt")


def load_variant(name: str):
    """The target is built at run time, so DEADWEIGHT will not name a file."""
    return torch.load(MODEL_ROOT / f"{name}.pt")
