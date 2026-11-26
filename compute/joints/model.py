"""Stage 2 joint models: PointNet control, dynamic EdgeConv and attention set encoders."""
from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn

from cadnn.pointnet import PointNetEncoder, mlp
from joints.data import AXIAL_IDS, LABELS, N_CH, N_EXTRA, N_LOCAL


@torch.no_grad()
def knn(p, k):
    """Indices (B,N,k) of each point's k nearest others in p (B,N,3)."""
    # Squared distances rank as distances do. They and the gather in the block export to ONNX; cdist and x[b, idx] did not.
    n = p.shape[1]
    sq = (p * p).sum(-1)
    d = sq[:, :, None] + sq[:, None, :] - 2 * p @ p.transpose(1, 2)
    # Points whose three values are equal (all zero after a ReLU, often) tie exactly, and PyTorch and onnxruntime
    # broke those ties differently: 4% of real pairs got another answer. The lower index now wins. That holds for
    # the normalised input coordinates (the static graph); feature distances can be too large for 1e-7 to show.
    d = d + torch.arange(n, dtype=d.dtype, device=d.device) * 1e-7
    return d.topk(k + 1, largest=False).indices[:, :, 1:]


class EdgeConvBlock(nn.Module):
    """DGCNN-style local edge aggregation over point features."""
    def __init__(self, in_ch, out_ch, k=12):
        super().__init__()
        self.k = int(k)
        self.net = nn.Sequential(nn.Conv2d(2 * in_ch, out_ch, 1), nn.BatchNorm2d(out_ch), nn.ReLU())

    def forward(self, x, idx=None):
        # x: B,N,C. Neighbours are selected without gradient; gathered features still carry gradients.
        n = x.shape[1]
        k = min(self.k, max(1, n - 1))
        if idx is None:
            idx = knn(x[:, :, :3], k)
        c = x.shape[2]
        nbr = x.gather(1, idx.flatten(1)[:, :, None].expand(-1, -1, c)).reshape(x.shape[0], n, k, c)
        ctr = x[:, :, None, :].expand_as(nbr)
        edge = torch.cat([ctr, nbr - ctr], dim=-1).permute(0, 3, 1, 2)
        return self.net(edge).max(dim=3).values.transpose(1, 2)


class EdgeConvEncoder(nn.Module):
    def __init__(self, in_ch=N_CH, widths=(64, 128, 256), k=12, graph='dynamic'):
        super().__init__()
        if graph not in ('dynamic', 'static'):
            raise ValueError(f'edge graph {graph!r}')
        self.graph = graph   # static: every block uses the neighbours of the input xyz; dynamic: of its own features
        blocks, c = [], in_ch
        for w in widths:
            blocks.append(EdgeConvBlock(c, w, k))
            c = w
        self.blocks = nn.ModuleList(blocks)
        self.in_ch, self.widths, self.k, self.out_dim = in_ch, tuple(widths), int(k), 2 * c

    def forward(self, x):
        idx = knn(x[:, :, :3], min(self.k, max(1, x.shape[1] - 1))) if self.graph == 'static' else None
        for block in self.blocks:
            x = block(x, idx)
        return torch.cat([x.max(dim=1).values, x.mean(dim=1)], dim=1)


class AttentionSetEncoder(nn.Module):
    """Linear point embedding followed by learned-query cross attention and token self attention.

    Complexity is O(points * tokens), avoiding full point-to-point attention while retaining global interactions.
    """
    def __init__(self, in_ch=N_CH, width=128, heads=4, tokens=16, layers=2):
        super().__init__()
        if width % heads:
            raise ValueError('attention width must be divisible by heads')
        self.in_ch, self.width, self.heads, self.tokens, self.layers = in_ch, width, heads, tokens, layers
        self.point = nn.Sequential(nn.Linear(in_ch, width), nn.LayerNorm(width), nn.GELU(),
                                   nn.Linear(width, width), nn.LayerNorm(width))
        self.seed = nn.Parameter(torch.randn(tokens, width) * 0.02)
        self.pool = nn.MultiheadAttention(width, heads, batch_first=True)
        self.self_attn = nn.ModuleList(nn.MultiheadAttention(width, heads, batch_first=True) for _ in range(layers))
        self.ffn = nn.ModuleList(nn.Sequential(nn.LayerNorm(width), nn.Linear(width, 4 * width), nn.GELU(),
                                               nn.Linear(4 * width, width)) for _ in range(layers))
        self.norm = nn.LayerNorm(width)
        self.out_dim = 2 * width

    def forward(self, x):
        p = self.point(x)
        q = self.seed[None].expand(x.shape[0], -1, -1)
        q = q + self.pool(q, p, p, need_weights=False)[0]
        for attn, ffn in zip(self.self_attn, self.ffn):
            z = self.norm(q)
            q = q + attn(z, z, z, need_weights=False)[0]
            q = q + ffn(q)
        q = self.norm(q)
        return torch.cat([q.max(dim=1).values, q.mean(dim=1)], dim=1)


def make_encoder(kind, in_ch, widths, edge_k=12, attn_width=128, attn_heads=4, attn_tokens=16, attn_layers=2,
                 edge_graph='dynamic'):
    if kind == 'pointnet':
        return PointNetEncoder(in_ch, widths)
    if kind == 'edgeconv':
        return EdgeConvEncoder(in_ch, widths, edge_k, edge_graph)
    if kind == 'attention':
        return AttentionSetEncoder(in_ch, attn_width, attn_heads, attn_tokens, attn_layers)
    raise ValueError(f'unknown encoder {kind}')


class JointNet(nn.Module):
    """(pa, pb, extra) -> type logits and a sign-ambiguous unit axis."""
    def __init__(self, widths=(64, 128, 256), head=(256, 128), dropout=0.2, in_ch=N_CH, extra_dim=N_EXTRA,
                 n_types=len(LABELS), encoder='pointnet', edge_k=12, attn_width=128, attn_heads=4,
                 attn_tokens=16, attn_layers=2, edge_graph='dynamic'):
        super().__init__()
        self.enc = make_encoder(encoder, in_ch, widths, edge_k, attn_width, attn_heads, attn_tokens, attn_layers,
                                edge_graph)
        d = self.enc.out_dim
        self.trunk = mlp([4 * d + extra_dim, *head], dropout)
        self.type_head = nn.Linear(head[-1], n_types)
        self.axis_head = nn.Linear(head[-1], 3)

    def forward(self, pa, pb, extra):
        fa, fb = self.enc(pa), self.enc(pb)
        h = self.trunk(torch.cat([fa, fb, (fa - fb).abs(), fa * fb, extra], dim=1))
        return self.type_head(h), F.normalize(self.axis_head(h), dim=1, eps=1e-6)


def arch_of(args):
    return dict(encoder=args.encoder, widths=list(args.widths), head=list(args.head), dropout=float(args.dropout),
                edge_k=int(args.edge_k), attn_width=int(args.attn_width), attn_heads=int(args.attn_heads),
                attn_tokens=int(args.attn_tokens), attn_layers=int(args.attn_layers),
                edge_graph=getattr(args, 'edge_graph', 'dynamic'),
                in_ch=N_CH + (N_LOCAL if getattr(args, 'local_frame', False) else 0),
                extra_dim=N_EXTRA, n_types=len(LABELS))


def build(arch):
    # Defaults retain compatibility with checkpoints written before multiple encoders existed.
    return JointNet(widths=tuple(arch['widths']), head=tuple(arch['head']), dropout=arch['dropout'],
                    in_ch=arch['in_ch'], extra_dim=arch['extra_dim'], n_types=arch['n_types'],
                    encoder=arch.get('encoder', 'pointnet'), edge_k=arch.get('edge_k', 12),
                    attn_width=arch.get('attn_width', 128), attn_heads=arch.get('attn_heads', 4),
                    attn_tokens=arch.get('attn_tokens', 16), attn_layers=arch.get('attn_layers', 2),
                    edge_graph=arch.get('edge_graph', 'dynamic'))


def axial_mask(label, axis_mask):
    ax = torch.zeros_like(axis_mask)
    for i in AXIAL_IDS:
        ax = ax + (label == i).to(axis_mask.dtype)
    return ax * axis_mask


def joint_loss(logits, axis_pred, label, axis_gt, axis_mask, class_weight=None, axis_weight=1.0, focal_gamma=0.0):
    """Weighted CE or focal type loss plus sign-invariant axis loss."""
    raw = F.cross_entropy(logits, label, weight=class_weight, reduction='none')
    if focal_gamma:
        pt = logits.softmax(1).gather(1, label[:, None]).squeeze(1).clamp_min(1e-8)
        raw = raw * (1 - pt).pow(focal_gamma)
    ce = raw.mean()
    m = axial_mask(label, axis_mask)
    cos = (axis_pred * axis_gt).sum(1).abs().clamp(max=1.0)
    ax = ((1.0 - cos) * m).sum() / m.sum().clamp(min=1.0)
    return ce + axis_weight * ax, ce, ax
