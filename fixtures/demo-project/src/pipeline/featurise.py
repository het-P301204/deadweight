"""Feature construction. Synthetic; see README.md.

Nothing declares an environment for src/pipeline/**, so DEADWEIGHT reports the
load context as unresolved rather than guessing that it is development.
"""

import numpy as np

FEATURES = "models/features.npy"
EMBEDDINGS = "models/embeddings.npy"


def load_features():
    # allow_pickle=True re-enables unpickling of object arrays.
    return np.load(FEATURES, allow_pickle=True)


def load_embeddings():
    return np.load(EMBEDDINGS)


def build(rows: list[dict]) -> np.ndarray:
    lookup = load_features()
    space = load_embeddings()
    return np.stack([space[lookup.item().get(row["key"], 0)] for row in rows])
