"""Detector inference. Synthetic; see README.md."""

import onnxruntime

DETECTOR = "models/detector.onnx"
MISLABELLED = "models/mislabelled.safetensors"


def session():
    """Data only, with one caveat: a custom operator loads a native library."""
    return onnxruntime.InferenceSession(DETECTOR)


def broken_session():
    """The extension says safetensors. The bytes are a zip holding a pickle."""
    return onnxruntime.InferenceSession(MISLABELLED)
