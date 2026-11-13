"""Stage 3 models: the classifier and the autoencoder used for optional unsupervised pretraining. Both use the
same PointNet encoder as stage 2 (cadnn.pointnet)."""
from __future__ import annotations

import torch
from torch import nn

from cadnn.pointnet import PointNetEncoder, mlp
from parts.data import CLASSES

SIZE_DIM = 3


class PartNet(nn.Module):
    """(points (B, N, 3) normalised, size (B, 3) log10 extents in mm) -> class logits (B, C)."""

    def __init__(self, widths=(64, 128, 256), head=(256, 128), dropout=0.3, n_classes=len(CLASSES)):
        super().__init__()
        self.enc = PointNetEncoder(3, widths)
        self.head = nn.Sequential(mlp([self.enc.out_dim + SIZE_DIM, *head], dropout), nn.Linear(head[-1], n_classes))

    def forward(self, pts, size):
        return self.head(torch.cat([self.enc(pts), size], dim=1))


def arch_of(args):
    return dict(widths=list(args.widths), head=list(args.head), dropout=float(args.dropout), n_classes=len(CLASSES))


def build(arch):
    return PartNet(tuple(arch['widths']), tuple(arch['head']), arch['dropout'], arch['n_classes'])


class PointAE(nn.Module):
    """Encoder + fully connected decoder to n_out points; trained with the chamfer distance. Geometry only."""

    def __init__(self, widths=(64, 128, 256), n_out=1024, hidden=(512, 1024)):
        super().__init__()
        self.enc = PointNetEncoder(3, widths)
        self.n_out = n_out
        self.dec = nn.Sequential(mlp([self.enc.out_dim, *hidden]), nn.Linear(hidden[-1], n_out * 3))

    def forward(self, pts):
        return self.dec(self.enc(pts)).view(-1, self.n_out, 3)


def chamfer(a, b):
    """Symmetric chamfer distance (mean squared nearest-neighbour distance both ways), per sample."""
    d = torch.cdist(a, b) ** 2
    return d.min(dim=2).values.mean(dim=1) + d.min(dim=1).values.mean(dim=1)
