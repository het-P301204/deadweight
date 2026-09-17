"""Index build step, run while the image is produced. Synthetic; see README.md."""

import pickle
import shutil

from sentence_transformers import SentenceTransformer

RETRIEVER = "atlas-internal/retriever-base"
THRESHOLDS = "weights/thresholds.pkl"


def load_retriever():
    return SentenceTransformer(RETRIEVER)


def load_thresholds():
    # The same file the request handler loads, unpickled again here. Whatever
    # this step produces is baked into the image that ships.
    with open(THRESHOLDS, "rb") as handle:
        return pickle.load(handle)


def build() -> None:
    model = load_retriever()
    bands = load_thresholds()
    shutil.copytree("models", "dist/models", dirs_exist_ok=True)
    print(model, bands)
