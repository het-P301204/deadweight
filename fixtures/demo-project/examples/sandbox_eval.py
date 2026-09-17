"""Scratch evaluation script. Synthetic; see README.md.

Same loader as the request handler, a very different place for it to happen.
Two coordinates, not one score.
"""

import joblib

PIPELINE = "models/pipeline.joblib"


def main() -> None:
    model = joblib.load(PIPELINE)
    print(model.score([[0.0, 1.0]], [1]))


if __name__ == "__main__":
    main()
