"""Checkpoint smoke test, run on the build fleet. Synthetic; see README.md."""

import subprocess
import sys

import torch

CANDIDATE = "weights/ranker.bin"


def main() -> int:
    # Runs with whatever the CI job's token can reach, and the file it loads
    # was produced by a step earlier in the same pipeline.
    state = torch.load(CANDIDATE)
    if not state:
        print("empty checkpoint", file=sys.stderr)
        return 1
    subprocess.run(["./scripts/publish.sh", CANDIDATE], check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
