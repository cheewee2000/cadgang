"""The PointNet-style encoder both stages use: a shared per-point MLP (1x1 convolutions) and a symmetric pool.

No input transform net (T-Net): the stages either keep world orientation on purpose (stage 2's axis is in world
coordinates) or augment with rotations (stage 3)."""
from __future__ import annotations

import torch
from torch import nn

ENCODER_KIND = 'unsupervised-pretrain'


class PointNetEncoder(nn.Module):
    """(B, N, C) points -> (B, 2 * widths[-1]) features: max and mean pooled over the points."""

    def __init__(self, in_ch=3, widths=(64, 128, 256)):
        super().__init__()
        layers, c = [], in_ch
        for w in widths:
            layers += [nn.Conv1d(c, w, 1), nn.BatchNorm1d(w), nn.ReLU()]
            c = w
        self.net = nn.Sequential(*layers)
        self.in_ch, self.widths, self.out_dim = in_ch, tuple(int(w) for w in widths), 2 * c

    def forward(self, x):
        h = self.net(x.transpose(1, 2))
        return torch.cat([h.max(dim=2).values, h.mean(dim=2)], dim=1)


def mlp(dims, dropout=0.0):
    """Linear + ReLU (+ Dropout) for each consecutive pair of dims."""
    layers = []
    for a, b in zip(dims[:-1], dims[1:]):
        layers += [nn.Linear(a, b), nn.ReLU()]
        if dropout:
            layers.append(nn.Dropout(dropout))
    return nn.Sequential(*layers)


def encoder_payload(enc, **meta):
    """What compute/parts pretrain writes as encoder.pt: the encoder's weights, tagged as unsupervised."""
    return dict(kind=ENCODER_KIND, in_ch=enc.in_ch, widths=list(enc.widths), state=enc.state_dict(), **meta)


def load_encoder(enc, path):
    """Load an encoder.pt into enc. Refuses anything that is not an unsupervised pretrain file or whose shape
    differs. Returns the file's metadata (no weights) for the run's config and report."""
    from .runtime import load_ckpt
    ck = load_ckpt(path)
    if not isinstance(ck, dict) or ck.get('kind') != ENCODER_KIND:
        raise SystemExit(f'{path}: not an encoder file written by `compute/parts/main.py pretrain`')
    if int(ck['in_ch']) != enc.in_ch or tuple(ck['widths']) != enc.widths:
        raise SystemExit(f'{path}: encoder has in_ch={ck["in_ch"]} widths={ck["widths"]}, the model wants '
                         f'in_ch={enc.in_ch} widths={list(enc.widths)} (pass the same --widths)')
    enc.load_state_dict(ck['state'])
    return {k: v for k, v in ck.items() if k != 'state'} | {'path': str(path)}
