"""Stage 2 tests on synthetic fixtures. Run: python3 -m unittest discover -s compute/tests -v
Data tests need numpy; model and training tests need torch and skip without it."""
import json
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import numpy as np
except ImportError:   # pragma: no cover
    np = None
try:
    import torch
except ImportError:
    torch = None

needs_np = unittest.skipIf(np is None, 'numpy is not installed')
needs_torch = unittest.skipIf(torch is None or np is None, 'torch is not installed: stage 2 model tests skipped')


def _asm(parts, mates, solve=()):
    return dict(id='t', parts=parts, mates=mates, solve=list(solve))


def _p(occ, bbox, first=0, count=10, part='x'):
    return dict(occ=occ, part=part, first=first, count=count, bbox=bbox)


@needs_np
class JointData(unittest.TestCase):
    def test_bbox_gap(self):
        from joints.data import bbox_gap
        a = [0, 0, 0, 1, 1, 1]
        self.assertEqual(bbox_gap(a, [1, 0, 0, 2, 1, 1]), 0.0)
        self.assertEqual(bbox_gap(a, [0.5, 0.5, 0.5, 2, 2, 2]), 0.0)
        self.assertAlmostEqual(bbox_gap(a, [3, 0, 0, 4, 1, 1]), 2.0)
        self.assertAlmostEqual(bbox_gap(a, [2, 2, 0, 3, 3, 1]), 2 ** 0.5)

    def test_pairs_labels_fold_priority_and_order(self):
        from joints.data import LABEL_ID, pairs_of
        big, small, far, other = [0, 0, 0, 10, 10, 10], [10.5, 0, 0, 12, 2, 2], [50, 50, 50, 51, 51, 51], [0, 0, 10.2, 3, 3, 13]
        asm = _asm([_p(7, big, 0), _p(3, small, 10), _p(9, far, 20), _p(4, other, 30)],
                   [dict(type='FASTENED', occs=[7, 3], axis=[0, 0, 1]),
                    dict(type='REVOLUTE', occs=[3, 7], axis=[0, 0, 2]),     # same pair: REVOLUTE wins, axis normalised
                    dict(type='PIN_SLOT', occs=[7, 4], axis=[1, 0, 0]),     # folds to SLIDER
                    dict(type='PARALLEL', occs=[3, 4], axis=[0, 1, 0]),     # 3 and 4 do not touch
                    dict(type='FASTENED', occs=[7, 9], axis=[0, 0, 1]),     # far: not a pair
                    dict(type='GEAR', occs=[7, 4], axis=[0, 0, 1])],        # outside the label set
                   [dict(occ=3, dir=[0, 0, -1]), dict(occ=7, dir=None)])
        rows, st = pairs_of(asm, 1.0)
        by = {(r['occ_a'], r['occ_b']): r for r in rows}
        self.assertEqual(set(by), {(3, 7), (4, 7)}, 'smaller part first; far and separated pairs dropped')
        self.assertEqual(by[(3, 7)]['label'], LABEL_ID['REVOLUTE'])
        np.testing.assert_allclose(by[(3, 7)]['axis'], [0, 0, 1])
        np.testing.assert_allclose(by[(3, 7)]['solver_dir'], [0, 0, -1])
        self.assertEqual(by[(4, 7)]['label'], LABEL_ID['SLIDER'])
        self.assertTrue(np.all(np.isnan(by[(4, 7)]['solver_dir'])), 'no solver answer for occ 4')
        self.assertEqual(st['mate_not_touching'], 2)
        self.assertEqual(st['mate_type_skipped:GEAR'], 1)
        self.assertEqual(st['mate_folded:PIN_SLOT->SLIDER'], 1)
        self.assertEqual(st['pair_several_mate_types'], 1)

    def test_make_pair_normalised_deterministic_and_contact(self):
        from cadnn.util import rng_for
        from joints.data import make_pair, near
        g = np.linspace(0, 10, 6)
        # two 10 mm cubes' vertex grids sharing the face x = 10 (B shifted by 10 on x)
        cube = np.array([[x, y, z] for x in g for y in g for z in g])
        A, B = cube, cube + [10, 0, 0]
        ba, bb = [*A.min(0), *A.max(0)], [*B.min(0), *B.max(0)]
        xa, xb, extra = make_pair(A, B, ba, bb, 512, 1.0, rng_for(1, 'a'), rng_for(1, 'b'))
        xa2, _, _ = make_pair(A, B, ba, bb, 512, 1.0, rng_for(1, 'a'), rng_for(1, 'b'))
        np.testing.assert_array_equal(xa, xa2)
        self.assertEqual(xa.shape, (512, 5))
        both = np.concatenate([xa[:, :3], xb[:, :3]])   # 512 > 216 vertices: every vertex is in the sample
        np.testing.assert_allclose((both.min(0) + both.max(0)) / 2, 0, atol=1e-6)
        self.assertAlmostEqual(float(np.linalg.norm(both.max(0) - both.min(0))), 1.0, places=5)
        on_face = np.isclose(xa[:, 0], xa[:, 0].max())
        self.assertTrue(np.all(xa[on_face, 3] == 1), 'points on the shared face are in contact')
        self.assertTrue(np.all(xa[~on_face, 3] == 0), 'points 2 mm or more away are not')
        self.assertAlmostEqual(float(extra[0]), np.log10(np.linalg.norm([20, 10, 10])), places=5)
        p = np.random.default_rng(0).uniform(0, 20, (300, 3))
        np.testing.assert_array_equal(near(p, B, 1.5, use_kdtree=False), near(p, B, 1.5, use_kdtree=True))

    def test_index_split_by_assembly_and_dataset(self):
        from joints.data import LABEL_ID, LABELS, PairDataset, build_index, load_index, train_rows_for_epoch
        from joints.synth import write_dump
        with tempfile.TemporaryDirectory() as t:
            write_dump(f'{t}/dump', 10, seed=3)
            meta = build_index(f'{t}/dump', f'{t}/idx', seed=0, val=0.3, test=0.3, log=lambda *a: None)
            idx, meta2 = load_index(f'{t}/idx')
            self.assertEqual(meta['pairs'], len(idx['label']))
            self.assertEqual(meta2['synthetic_assemblies'], 10)
            for ai in np.unique(idx['asm']):
                self.assertEqual(len(np.unique(idx['split'][idx['asm'] == ai])), 1, 'an assembly sits in one split')
            present = {LABELS[l] for l in np.unique(idx['label'])}
            self.assertTrue({'REVOLUTE', 'SLIDER', 'CYLINDRICAL', 'PLANAR', 'FASTENED', 'BALL', 'NONE'} <= present)
            self.assertGreater(meta['stats']['mate_not_touching'], 0)
            self.assertGreater(meta['stats']['mate_folded:PIN_SLOT->SLIDER'], 0)
            ds = PairDataset(idx, f'{t}/dump', n_points=64, seed=0, train=False)
            it = ds[0]
            self.assertEqual(it['pa'].shape, (64, 5))
            self.assertEqual(it['extra'].shape, (4,))
            np.testing.assert_array_equal(ds[0]['pa'], ds[(0, 5)]['pa'], 'eval sampling ignores the epoch')
            tr = PairDataset(idx, f'{t}/dump', n_points=64, seed=0, train=True, augment='so3')
            self.assertFalse(np.array_equal(tr[(0, 0)]['pa'], tr[(0, 1)]['pa']), 'training resamples per epoch')
            np.testing.assert_array_equal(tr[(0, 1)]['pa'], tr[(0, 1)]['pa'])
            ax = [i for i in range(len(ds)) if idx['label'][i] == LABEL_ID['REVOLUTE']][0]
            a, b = ds[ax], tr[(ax, 2)]
            self.assertEqual(a['axis_mask'], 1)
            self.assertAlmostEqual(float(np.linalg.norm(b['axis'])), 1.0, places=5)
            # vertices read through the memory map are the part's own
            f32 = np.fromfile(f'{t}/dump/{idx["asm_ids"][idx["asm"][0]]}.f32', dtype='<f4').reshape(-1, 3)
            v = ds.vertices(idx['asm'][0], idx['first_a'][0], idx['count_a'][0])
            np.testing.assert_array_equal(v, f32[idx['first_a'][0]:idx['first_a'][0] + idx['count_a'][0]])
            bbox = idx['bbox_a'][0]
            self.assertTrue(np.all(v.min(0) >= bbox[:3] - 2e-3) and np.all(v.max(0) <= bbox[3:] + 2e-3))
            r0, r1 = train_rows_for_epoch(idx, 0, 0, 1.0), train_rows_for_epoch(idx, 1, 0, 1.0)
            self.assertEqual(len(r0), len(r1))
            lab = idx['label'][r0]
            self.assertLessEqual((lab == LABEL_ID['NONE']).sum(), (lab != LABEL_ID['NONE']).sum())

    def test_index_skips_truncated_vertex_file(self):
        from joints.data import build_index
        from joints.synth import write_dump
        with tempfile.TemporaryDirectory() as t:
            ids = write_dump(f'{t}/dump', 3, seed=1)
            p = Path(f'{t}/dump/{ids[0]}.f32')
            p.write_bytes(p.read_bytes()[:-12])
            meta = build_index(f'{t}/dump', f'{t}/idx', log=lambda *a: None)
            self.assertEqual(meta['stats']['asm_f32_size_mismatch'], 1)
            self.assertEqual(meta['assemblies'], 2)


@needs_torch
class JointModel(unittest.TestCase):
    def test_forward_shapes_and_axis_loss_only_for_axial(self):
        from joints.data import LABEL_ID
        from joints.model import JointNet, joint_loss
        torch.manual_seed(0)
        m = JointNet(widths=(8, 16), head=(16,))
        pa, pb, ex = torch.randn(4, 32, 5), torch.randn(4, 32, 5), torch.randn(4, 4)
        logits, axis = m(pa, pb, ex)
        self.assertEqual(tuple(logits.shape), (4, 7))
        torch.testing.assert_close(axis.norm(dim=1), torch.ones(4))
        gt = torch.tensor([[0., 0, 1]] * 4)
        none = torch.full((4,), LABEL_ID['NONE'])
        loss, ce, ax = joint_loss(logits, axis, none, gt, torch.ones(4))
        self.assertEqual(float(ax), 0.0)
        m.zero_grad()
        loss.backward()
        self.assertTrue(m.axis_head.weight.grad is None or float(m.axis_head.weight.grad.abs().sum()) == 0.0)
        fast = torch.full((4,), LABEL_ID['FASTENED'])
        self.assertEqual(float(joint_loss(logits, axis, fast, gt, torch.ones(4))[2]), 0.0)
        rev = torch.full((4,), LABEL_ID['REVOLUTE'])
        self.assertAlmostEqual(float(joint_loss(logits, gt, rev, gt, torch.ones(4))[2]), 0.0, places=6)
        self.assertAlmostEqual(float(joint_loss(logits, -gt, rev, gt, torch.ones(4))[2]), 0.0, places=6, msg='sign-invariant')
        side = torch.tensor([[1., 0, 0]] * 4)
        self.assertAlmostEqual(float(joint_loss(logits, side, rev, gt, torch.ones(4))[2]), 1.0, places=6)
        self.assertEqual(float(joint_loss(logits, side, rev, gt, torch.zeros(4))[2]), 0.0, 'masked axis')


@needs_torch
class JointTraining(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from joints.data import build_index
        from joints.synth import write_dump
        cls.tmp = tempfile.TemporaryDirectory()
        t = cls.t = cls.tmp.name
        write_dump(f'{t}/dump', 12, seed=5)
        build_index(f'{t}/dump', f'{t}/idx', seed=0, val=0.2, test=0.2, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _args(self, out, *extra):
        from joints.main import build_parser
        return build_parser().parse_args(['train', '--index', f'{self.t}/idx', '--out', out, '--device', 'cpu',
                                          '--epochs', '2', '--batch-size', '8', '--points', '48', '--widths', '8,16',
                                          '--head', '16', '--workers', '0', '--log-every', '0', '--augment', 'so3', *extra])

    def test_train_resume_after_sigterm_matches_uninterrupted(self):
        from cadnn.runtime import load_ckpt
        from joints import train as T
        a = T.train(self._args(f'{self.t}/runA'))
        self.assertFalse(a['stopped'])
        self.assertTrue(a['finished'])

        def kill_at_3(state):
            if state['step'] == 3:
                os.kill(os.getpid(), signal.SIGTERM)

        b = T.train(self._args(f'{self.t}/runB'), on_step=kill_at_3)
        self.assertTrue(b['stopped'])
        self.assertEqual(b['step'], 3)
        self.assertEqual(b['exit_code'], 128 + signal.SIGTERM)
        self.assertEqual(signal.getsignal(signal.SIGTERM), signal.SIG_DFL, 'handlers restored')
        with self.assertRaises(SystemExit):
            T.train(self._args(f'{self.t}/runB'))   # neither --resume nor --overwrite: refuse to clobber
        c = T.train(self._args(f'{self.t}/runB', '--resume'))
        self.assertTrue(c['finished'])
        self.assertEqual(c['step'], a['step'])
        sa, sb = load_ckpt(f'{self.t}/runA/last.pt')['model'], load_ckpt(f'{self.t}/runB/last.pt')['model']
        for k in sa:
            torch.testing.assert_close(sa[k].float(), sb[k].float(), rtol=1e-5, atol=1e-6, msg=k)
        rows = [json.loads(l) for l in open(f'{self.t}/runB/metrics.jsonl')]
        self.assertEqual([r['event'] for r in rows], ['stopped', 'epoch', 'epoch'])

    def test_eval_report_and_export(self):
        from joints import train as T
        from joints.main import build_parser, main
        out = f'{self.t}/runE'
        T.train(self._args(out, '--epochs', '1'))
        rep = f'{self.t}/report'
        self.assertEqual(main(['eval', '--index', f'{self.t}/idx', '--ckpt', f'{out}/best.pt', '--split', 'all',
                               '--report', rep, '--device', 'cpu', '--workers', '0', '--predictions', f'{self.t}/pred.jsonl']), 0)
        m = json.loads(Path(rep + '.json').read_text())['metrics']
        self.assertEqual(set(m['per_class']), {'FASTENED', 'REVOLUTE', 'SLIDER', 'CYLINDRICAL', 'PLANAR', 'BALL', 'NONE'})
        for name in ('REVOLUTE', 'SLIDER', 'CYLINDRICAL'):
            a = m['axis'][name]
            self.assertGreater(a['n'], 0)
            self.assertIn('median', a['model'])
            self.assertIn('solver_coverage', a)
        md = Path(rep + '.md').read_text()
        self.assertIn('Synthetic data', md)
        self.assertIn('solver median', md)
        self.assertGreater(len(Path(f'{self.t}/pred.jsonl').read_text().splitlines()), 0)
        args = build_parser().parse_args(['export', '--ckpt', f'{out}/best.pt', '--out', f'{self.t}/j.onnx'])
        try:
            code = T.export(args)
        except Exception as e:   # the exporter's own dependencies (onnx / onnxscript) differ across torch versions
            self.skipTest(f'ONNX export unavailable here: {type(e).__name__}: {e}')
        r = json.loads(Path(f'{self.t}/j.onnx.json').read_text())
        if not r.get('ok'):
            self.skipTest(r.get('error'))
        self.assertEqual(code, 0 if r.get('verified') is not False else 5)
        self.assertTrue(r['under_target'])
        self.assertLess(r['mb'], 10)
        self.assertEqual(r['contract']['labels'][-1], 'NONE')


if __name__ == '__main__':
    unittest.main()
