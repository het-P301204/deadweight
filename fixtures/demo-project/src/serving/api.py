"""Request handlers for the triage service. Synthetic; see README.md."""

import os
from pathlib import Path

import boto3
import pickle
import torch
from fastapi import FastAPI

MODEL_DIR = Path("weights")
CLASSIFIER = MODEL_DIR / "classifier.pkl"
THRESHOLDS = MODEL_DIR / "thresholds.pkl"

app = FastAPI(title="atlas-triage")

# Cloud client and secret material live in the same process that loads the
# model, which is the whole point of the fixture.
s3 = boto3.client("s3")
SIGNING_KEY = os.environ["ATLAS_SIGNING_SECRET"]


def load_classifier():
    """Executes on load: pickle.load runs whatever the stream names."""
    with open(CLASSIFIER, "rb") as handle:
        return pickle.load(handle)


def load_thresholds():
    with open(THRESHOLDS, "rb") as handle:
        return pickle.load(handle)


def load_scorer():
    """Guarded: the restricted unpickler is asked for explicitly."""
    return torch.load("weights/ranker.bin", weights_only=True, map_location="cpu")


@app.post("/v1/triage")
def triage(payload: dict) -> dict:
    model = load_classifier()
    bands = load_thresholds()
    score = model.predict(payload["text"])
    s3.put_object(Bucket="atlas-triage-audit", Key=payload["id"], Body=str(score))
    return {"score": score, "band": bands.get("threshold")}
