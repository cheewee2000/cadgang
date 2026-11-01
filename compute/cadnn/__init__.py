"""Shared pieces for the compute stages: numpy helpers (util), the PointNet encoder (pointnet) and the torch
runtime (runtime: device choice, SIGTERM-safe checkpoints, the resumable training loop, ONNX export).

util imports numpy only; pointnet and runtime import torch."""
