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


def load_encoder_xyz(enc, path):
    """Transfer a 3-channel geometry encoder into an encoder with extra per-point channels.

    The XYZ columns of the first convolution are copied; newly introduced channels keep their random
    initialization. BatchNorm and every later layer are copied exactly. This lets the joint model retain its
    contact/inside features while starting its geometric representation from parts pretraining.
    """
    from .runtime import load_ckpt
    ck = load_ckpt(path)
    if not isinstance(ck, dict) or ck.get('kind') != ENCODER_KIND:
        raise SystemExit(f'{path}: not an encoder file written by `compute/parts/main.py pretrain`')
    if int(ck.get('in_ch', -1)) != 3 or tuple(ck.get('widths', ())) != enc.widths or enc.in_ch < 3:
        raise SystemExit(f'{path}: encoder has in_ch={ck.get("in_ch")} widths={ck.get("widths")}, the model wants '
                         f'XYZ transfer into in_ch={enc.in_ch} widths={list(enc.widths)} (pass the same --widths)')
    dst, src = enc.state_dict(), ck['state']
    first = 'net.0.weight'
    if first not in src or first not in dst or src[first].shape[1] != 3 or dst[first].shape[1] != enc.in_ch:
        raise SystemExit(f'{path}: unsupported encoder layout for XYZ transfer')
    for k, v in src.items():
        if k == first:
            if v.shape[0] != dst[k].shape[0] or v.shape[2:] != dst[k].shape[2:]:
                raise SystemExit(f'{path}: first encoder layer shape does not match')
            dst[k][:, :3].copy_(v)
        elif k not in dst or dst[k].shape != v.shape:
            raise SystemExit(f'{path}: encoder tensor {k} has shape {tuple(v.shape)}, expected '
                             f'{tuple(dst[k].shape) if k in dst else "missing"}')
        else:
            dst[k].copy_(v)
    enc.load_state_dict(dst)
    return {k: v for k, v in ck.items() if k != 'state'} | {'path': str(path), 'transfer': 'xyz'}
