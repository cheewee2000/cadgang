"""Stage 2 model: one PointNet encoder shared by both parts, an MLP on the pair, a type head and an axis head."""
from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn

from cadnn.pointnet import PointNetEncoder, mlp
from joints.data import AXIAL_IDS, LABELS, N_CH, N_EXTRA


class JointNet(nn.Module):
    """(pa, pb, extra) -> (type logits (B, 7), unit axis (B, 3)). pa is the smaller part. The pair feature is
    [fa, fb, |fa - fb|, fa * fb, extra]."""

    def __init__(self, widths=(64, 128, 256), head=(256, 128), dropout=0.2, in_ch=N_CH, extra_dim=N_EXTRA,
                 n_types=len(LABELS)):
        super().__init__()
        self.enc = PointNetEncoder(in_ch, widths)
        d = self.enc.out_dim
        self.trunk = mlp([4 * d + extra_dim, *head], dropout)
        self.type_head = nn.Linear(head[-1], n_types)
        self.axis_head = nn.Linear(head[-1], 3)

    def forward(self, pa, pb, extra):
        fa, fb = self.enc(pa), self.enc(pb)
        h = self.trunk(torch.cat([fa, fb, (fa - fb).abs(), fa * fb, extra], dim=1))
        return self.type_head(h), F.normalize(self.axis_head(h), dim=1, eps=1e-6)


def arch_of(args):
    return dict(widths=list(args.widths), head=list(args.head), dropout=float(args.dropout), in_ch=N_CH,
                extra_dim=N_EXTRA, n_types=len(LABELS))


def build(arch):
    return JointNet(widths=tuple(arch['widths']), head=tuple(arch['head']), dropout=arch['dropout'],
                    in_ch=arch['in_ch'], extra_dim=arch['extra_dim'], n_types=arch['n_types'])


def axial_mask(label, axis_mask):
    """1 where the ground truth is REVOLUTE / SLIDER / CYLINDRICAL with a valid axis."""
    ax = torch.zeros_like(axis_mask)
    for i in AXIAL_IDS:
        ax = ax + (label == i).to(axis_mask.dtype)
    return ax * axis_mask


def joint_loss(logits, axis_pred, label, axis_gt, axis_mask, class_weight=None, axis_weight=1.0):
    """Cross entropy on the type plus a sign-invariant axis loss, 1 - |cos|, over the axial pairs only.
    Returns (total, type loss, axis loss)."""
    ce = F.cross_entropy(logits, label, weight=class_weight)
    m = axial_mask(label, axis_mask)
    cos = (axis_pred * axis_gt).sum(1).abs().clamp(max=1.0)
    ax = ((1.0 - cos) * m).sum() / m.sum().clamp(min=1.0)
    return ce + axis_weight * ax, ce, ax
