"""Torch runtime shared by stages 2 and 3: device choice, SIGTERM-safe checkpoints, a resumable training loop
and ONNX export with a size check.

Resume is exact on the CPU: the epoch order is a function of (seed, epoch), samples are functions of their key
(cadnn.util.rng_for), and the checkpoint carries model, optimiser, scheduler, position in the epoch and torch's
RNG state. On a GPU the result can differ in the last bits (non-deterministic kernels), not in the data order."""
from __future__ import annotations

import json
import math
import os
import shutil
import signal
import sys
import time
from pathlib import Path

import numpy as np
import torch

from .util import clean, rng_for


def log_err(*a):
    print(*a, file=sys.stderr, flush=True)


def pick_device(name='auto'):
    """auto: CUDA or ROCm GPU if torch sees one, else Apple MPS, else CPU. 'rocm', 'hip' and 'gpu' mean 'cuda'
    (ROCm builds of torch expose the GPU as the cuda device). An explicit GPU request without a GPU is an error,
    not a silent CPU run."""
    name = (name or 'auto').lower()
    if name == 'auto':
        if torch.cuda.is_available():
            return torch.device('cuda')
        mps = getattr(torch.backends, 'mps', None)
        if mps is not None and mps.is_available():
            return torch.device('mps')
        return torch.device('cpu')
    if name in ('gpu', 'rocm', 'hip'):
        name = 'cuda'
    if name.startswith('cuda') and not torch.cuda.is_available():
        raise SystemExit(f'--device {name}: torch {torch.__version__} sees no GPU '
                         f'(cuda={torch.version.cuda}, hip={getattr(torch.version, "hip", None)})')
    return torch.device(name)


def describe_device(dev):
    if dev.type == 'cuda':
        idx = dev.index if dev.index is not None else torch.cuda.current_device()
        hip = getattr(torch.version, 'hip', None)
        return f'{dev} ({torch.cuda.get_device_name(idx)}, {"ROCm/HIP " + str(hip) if hip else "CUDA " + str(torch.version.cuda)})'
    return str(dev)


class StopFlag:
    """SIGTERM / SIGINT set a flag; the training loop checkpoints after the current batch and returns. A second
    Ctrl-C raises KeyboardInterrupt for an impatient human."""

    def __init__(self):
        self.requested, self.signal, self._old = False, None, {}

    def install(self, sigs=(signal.SIGTERM, signal.SIGINT)):
        for s in sigs:
            try:
                self._old[s] = signal.signal(s, self._handle)
            except (ValueError, OSError):   # not the main thread
                pass
        return self

    def _handle(self, signum, frame):
        if self.requested and signum == signal.SIGINT:
            raise KeyboardInterrupt
        self.requested, self.signal = True, signum
        log_err(f'\n{signal.Signals(signum).name}: checkpointing after this batch')

    def restore(self):
        for s, h in self._old.items():
            signal.signal(s, h)
        self._old.clear()

    @property
    def exit_code(self):
        return 128 + int(self.signal) if self.signal else 1


def save_ckpt(path, obj):
    """torch.save to a temp file and rename, so a kill mid-write leaves the previous checkpoint intact."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    torch.save(obj, tmp)
    os.replace(tmp, path)


def _copy(src, dst):
    tmp = Path(dst).with_name(Path(dst).name + '.tmp')
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def load_ckpt(path, device='cpu'):
    try:
        return torch.load(path, map_location=device, weights_only=False)
    except TypeError:   # torch < 1.13 has no weights_only
        return torch.load(path, map_location=device)


def fit(*, model, dataset, rows_for_epoch, step_fn, eval_fn, out_dir, config, device, epochs, batch_size,
        lr=1e-3, weight_decay=1e-4, workers=0, seed=0, resume=False, overwrite=False, ckpt_every=500,
        grad_clip=1.0, log_every=50, on_step=None, log=log_err):
    """Train with AdamW and a cosine schedule, writing out_dir/last.pt (every ckpt_every steps, every epoch, on
    SIGTERM), out_dir/best.pt (best eval score) and out_dir/metrics.jsonl.

    dataset[(row, epoch)] returns a dict of arrays; rows_for_epoch(epoch) the training rows of that epoch (must be
    deterministic); step_fn(model, batch) -> (loss, {name: float}); eval_fn(model) -> dict with an optional
    'score' (higher is better), called in eval mode at the end of every epoch.

    Returns dict(stopped, epoch, batch, step, best, finished). stopped=True means a signal ended the run after a
    checkpoint; run again with resume=True to continue from the same batch."""
    from torch.utils.data import DataLoader

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    last, best = out / 'last.pt', out / 'best.pt'
    torch.manual_seed(seed)
    model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    per_epoch = max(1, math.ceil(len(rows_for_epoch(0)) / batch_size))
    total = max(1, epochs * per_epoch)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: 0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))
    state = dict(epoch=0, batch=0, step=0, best=None, finished=False)

    if overwrite and not (resume and last.exists()):
        for f in (last, best, out / 'metrics.jsonl'):   # nothing of an older run may outlive the new one
            f.unlink(missing_ok=True)
    if last.exists():
        if resume:
            ck = load_ckpt(last)
            if ck['config'].get('arch') != config.get('arch'):
                raise SystemExit(f'{last} was trained with arch {ck["config"].get("arch")}, this run asks for '
                                 f'{config.get("arch")}; use the same model options or a new --out')
            model.load_state_dict(ck['model'])
            opt.load_state_dict(ck['opt'])
            sched.load_state_dict(ck['sched'])
            state.update(ck['state'])
            torch.set_rng_state(ck['rng']['torch'].cpu())
            if device.type == 'cuda' and ck['rng'].get('cuda') is not None:
                try:
                    torch.cuda.set_rng_state_all(ck['rng']['cuda'])
                except (RuntimeError, IndexError) as e:
                    log(f'cuda RNG state not restored ({e}); data order is unaffected')
            log(f'resumed {last}: epoch {state["epoch"]} batch {state["batch"]} step {state["step"]}')
            if state['finished'] and state['epoch'] >= epochs:
                log('that run had finished; nothing to do (raise --epochs to train further)')
                return dict(stopped=False, **state)
            state['finished'] = False
        elif not overwrite:
            raise SystemExit(f'{last} exists: pass --resume to continue it or --overwrite to start again')
    elif resume:
        log(f'no {last} yet; starting fresh')

    def save(path):
        save_ckpt(path, dict(model=model.state_dict(), opt=opt.state_dict(), sched=sched.state_dict(),
                             state=dict(state), config=config,
                             rng=dict(torch=torch.get_rng_state(),
                                      cuda=torch.cuda.get_rng_state_all() if device.type == 'cuda' else None)))

    def record(row):
        with open(out / 'metrics.jsonl', 'a', encoding='utf-8') as f:
            f.write(json.dumps(clean(dict(time=round(time.time(), 1), **row))) + '\n')

    stop = StopFlag().install()
    try:
        while state['epoch'] < epochs:
            e = state['epoch']
            rows = np.asarray(rows_for_epoch(e), dtype=np.int64)
            order = rows[rng_for(seed, 'order', e).permutation(len(rows))]
            items = [(int(r), e) for r in order[state['batch'] * batch_size:]]
            n_batches = math.ceil(len(rows) / batch_size)
            # the loader gets its own generator so making one does not draw from torch's global RNG (dropout's)
            loader = DataLoader(dataset, batch_size=batch_size, sampler=items, num_workers=workers,
                                generator=torch.Generator().manual_seed(seed + e), pin_memory=device.type == 'cuda')
            model.train()
            tot, n, extra, t0 = 0.0, 0, {}, time.time()
            for batch in loader:
                batch = {k: (v.to(device, non_blocking=True) if torch.is_tensor(v) else v) for k, v in batch.items()}
                loss, parts = step_fn(model, batch)
                opt.zero_grad(set_to_none=True)
                loss.backward()
                if grad_clip:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
                opt.step()
                sched.step()
                state['batch'] += 1
                state['step'] += 1
                tot += float(loss.detach())
                n += 1
                for k, v in (parts or {}).items():
                    extra[k] = extra.get(k, 0.0) + float(v)
                if log_every and state['step'] % log_every == 0:
                    log(f'epoch {e} batch {state["batch"]}/{n_batches} step {state["step"]} loss {tot / n:.4f} '
                        + ' '.join(f'{k} {v / n:.4f}' for k, v in extra.items())
                        + f' lr {sched.get_last_lr()[0]:.2e} {n / max(time.time() - t0, 1e-9):.1f} it/s')
                if on_step:
                    on_step(dict(state))
                if stop.requested:
                    save(last)
                    record(dict(event='stopped', signal=int(stop.signal), **state))
                    log(f'checkpoint {last} at epoch {e} batch {state["batch"]}; resume with --resume')
                    return dict(stopped=True, signal=int(stop.signal), exit_code=stop.exit_code, **state)
                if ckpt_every and state['step'] % ckpt_every == 0:
                    save(last)
            save(last)   # the epoch's training is safe before a possibly long eval; a resume from here redoes the eval
            model.eval()
            m = eval_fn(model) or {}
            state['epoch'], state['batch'] = e + 1, 0
            score = m.get('score')
            improved = score is not None and (state['best'] is None or score > state['best'])
            if improved:
                state['best'] = score
            record(dict(event='epoch', epoch=e, step=state['step'], train_loss=tot / n if n else None,
                        **{f'train_{k}': v / n for k, v in extra.items() if n}, seconds=round(time.time() - t0, 1), **m))
            save(last)
            if improved:
                _copy(last, best)
            log(f'epoch {e} done: train loss {tot / max(n, 1):.4f}, eval '
                + ', '.join(f'{k} {v:.4f}' for k, v in m.items() if isinstance(v, float)))
            if stop.requested:
                record(dict(event='stopped', signal=int(stop.signal), **state))
                return dict(stopped=True, signal=int(stop.signal), exit_code=stop.exit_code, **state)
        state['finished'] = True
        save(last)
        if state['best'] is None:   # no eval score (no validation rows): the last weights are the ones to use
            _copy(last, best)
        return dict(stopped=False, **state)
    finally:
        stop.restore()


def export_onnx(model, example_inputs, path, input_names, output_names, dynamic_axes, opset=17, target_mb=10.0):
    """Export to ONNX on the CPU, measure the file against target_mb, and check it with onnxruntime when that is
    installed. Never claims what it did not check: 'verified' is None without onnxruntime, 'ok' is False with the
    error when export itself failed."""
    model = model.cpu().eval()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n_params = sum(p.numel() for p in model.parameters())
    rep = dict(path=str(path), target_mb=target_mb, params=int(n_params), fp32_param_mb=n_params * 4 / 2 ** 20,
               opset=opset, torch=torch.__version__)
    kw = dict(input_names=list(input_names), output_names=list(output_names), dynamic_axes=dynamic_axes,
              opset_version=opset, do_constant_folding=True)
    args = tuple(t.cpu() for t in example_inputs)
    try:
        try:
            torch.onnx.export(model, args, str(path), dynamo=False, **kw)
        except TypeError as e:   # torch without the dynamo switch: the TorchScript exporter is the only one
            if 'dynamo' not in str(e):
                raise
            torch.onnx.export(model, args, str(path), **kw)
    except Exception as e:   # missing exporter dependencies or an unsupported op: report it, do not crash
        rep.update(ok=False, error=f'ONNX export failed: {type(e).__name__}: {e}'[:2000])
        return rep
    size = path.stat().st_size + sum(f.stat().st_size for f in path.parent.glob(path.name + '.data'))
    rep.update(ok=True, bytes=int(size), mb=size / 2 ** 20, under_target=size / 2 ** 20 < target_mb)
    try:
        import onnx
        onnx.checker.check_model(str(path))
        rep['onnx_checker'] = 'passed'
    except ImportError:
        rep['onnx_checker'] = None
    except Exception as e:
        rep['onnx_checker'] = f'failed: {type(e).__name__}: {e}'[:2000]
        rep['verified'] = False
        return rep
    try:
        import onnxruntime as ort
    except ImportError:
        rep.update(verified=None, verify_note='onnxruntime not installed: the file was not run')
        return rep
    try:
        sess = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
        outs = sess.run(None, {n: t.numpy() for n, t in zip(input_names, args)})
    except Exception as e:
        rep.update(verified=False, verify_note=f'onnxruntime failed: {type(e).__name__}: {e}'[:2000])
        return rep
    with torch.no_grad():
        ref = model(*args)
    ref = ref if isinstance(ref, (tuple, list)) else (ref,)
    diff = max(float(np.abs(o - r.numpy()).max()) for o, r in zip(outs, ref))
    rep.update(ort_max_abs_diff=diff, verified=diff < 1e-3)
    return rep
