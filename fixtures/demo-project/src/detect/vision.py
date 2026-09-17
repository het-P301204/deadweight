"""Image classification. Synthetic; see README.md."""

from keras.models import load_model

VISION = "models/vision.h5"
REPORT_MODEL = "models/report.keras"


def load_vision():
    # keras==2.15.0 is pinned, and Keras 2 deserialises Lambda-layer bytecode
    # when it rebuilds a model from its stored configuration.
    return load_model(VISION)


def load_report_model():
    return load_model(REPORT_MODEL, safe_mode=True)
