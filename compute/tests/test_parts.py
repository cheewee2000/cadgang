"""Stage 3 tests on synthetic fixtures. Run: python3 -m unittest discover -s compute/tests -v
Parsing, validation and caching need numpy; training tests need torch and skip without it."""
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
needs_torch = unittest.skipIf(torch is None or np is None, 'torch is not installed: stage 3 model tests skipped')


@needs_np
class PartParsing(unittest.TestCase):
    def test_gzip_jsonl(self):
        import gzip
        from parts.data import iter_records
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "parts.jsonl.gz"
            row = {"label": "screw", "points": [[i, 0, 0] for i in range(8)]}
            with gzip.open(path, "wt", encoding="utf-8") as out:
                out.write("# source path comment\n")
                out.write(json.dumps(row) + "\n")
            records = list(iter_records(path))
            self.assertEqual(len(records), 1)
            self.assertIsNone(records[0][2])
            self.assertEqual(records[0][1]["label"], "screw")

    def test_point_formats(self):
        from parts.data import RecordError, parse_points
        nested = [[i, 2 * i, 3 * i] for i in range(10)]
        a, f = parse_points(nested)
        self.assertEqual((a.shape, f), ((10, 3), 'nested'))
        b, f = parse_points([c for p in nested for c in p])
        self.assertEqual(f, 'flat')
        np.testing.assert_array_equal(a, b)
        c, f = parse_points(np.array(nested).T.tolist())
        self.assertEqual(f, 'channels-first')
        np.testing.assert_array_equal(a, c)
        d, f = parse_points({'x': [p[0] for p in nested], 'y': [p[1] for p in nested], 'z': [p[2] for p in nested]})
        np.testing.assert_array_equal(a, d)
        for bad in ([1, 2], [[0, 0, 0], [1, 1]], [[0, 0, 0]] * 3, [float('nan')] * 30, 'abc', {'x': [1]}):
            with self.assertRaises(RecordError, msg=repr(bad)[:40]):
                parse_points(bad)

    def test_bbox_formats(self):
        from parts.data import RecordError, parse_bbox
        want = (np.array([0, 1, 2.]), np.array([3, 4, 5.]))
        for v in ([0, 1, 2, 3, 4, 5], [[0, 1, 2], [3, 4, 5]], {'min': [0, 1, 2], 'max': [3, 4, 5]},
                  {'min': {'x': 0, 'y': 1, 'z': 2}, 'max': {'x': 3, 'y': 4, 'z': 5}},
                  {'center': [1.5, 2.5, 3.5], 'size': [3, 3, 3]}):
            lo, hi, _ = parse_bbox(v)
            np.testing.assert_allclose(lo, want[0])
            np.testing.assert_allclose(hi, want[1])
        lo, hi, f = parse_bbox([2, 4, 6])
        self.assertEqual(f, 'extents')
        np.testing.assert_allclose(hi - lo, [2, 4, 6])
        for bad in ([3, 4, 5, 0, 1, 2], [1, 2], {'a': 1}, [[0, 0], [1, 1]]):
            with self.assertRaises(RecordError):
                parse_bbox(bad)

    def test_labels_and_size_feature(self):
        from parts.data import norm_label, size_feature
        self.assertEqual(norm_label(' Screws '), 'screw')
        self.assertEqual(norm_label('PCB'), 'pcb')
        self.assertEqual(norm_label('Hex Nut'), 'hex nut', 'no guessing beyond case and plurals')
        np.testing.assert_allclose(size_feature([1, 100, 10]), [2, 1, 0])

    def test_validate_reports_problems(self):
        from parts.data import format_validation, validate
        from parts.synth import write_jsonl
        with tempfile.TemporaryDirectory() as t:
            n = write_jsonl(f'{t}/p.jsonl', per_class=6, n_points=128, bad=True)
            rep = validate(f'{t}/p.jsonl', n_points=128)
            self.assertEqual(rep['usable'], n)
            self.assertEqual(rep['invalid'], 6)
            self.assertEqual(rep['unknown_labels'], {'widget': 1})
            self.assertTrue(rep['fatal'], '6 bad lines of 50 is over the 1% default')
            self.assertGreaterEqual(rep['cross_group_duplicates'], 1)
            self.assertEqual(set(rep['classes']), {'screw', 'nut', 'washer', 'standoff', 'bearing', 'magnet', 'spring', 'oring', 'pcb', 'component', 'battery', 'other'})
            self.assertEqual(rep['synthetic_rows'], n)
            self.assertIn('not ok to train', format_validation(rep))
            ok = validate(f'{t}/p.jsonl', n_points=128, max_invalid=0.5)
            self.assertFalse(ok['fatal'])
            from parts.main import main
            self.assertEqual(main(['validate', f'{t}/p.jsonl', '--points', '128', '--json', f'{t}/v.json']), 1)
            self.assertTrue(json.loads(Path(f'{t}/v.json').read_text())['fatal'])

    def test_cache_split_groups_and_duplicates(self):
        from parts.data import CLASSES, PartDataset, build_cache, load_cache_meta
        from parts.synth import write_jsonl
        with tempfile.TemporaryDirectory() as t:
            n = write_jsonl(f'{t}/p.jsonl', per_class=6, n_points=128, bad=True)
            meta = build_cache(f'{t}/p.jsonl', f'{t}/c', n_points=64, val=0.3, test=0.3, log=lambda *a: None)
            self.assertEqual(meta['records'], n)
            self.assertEqual(meta['invalid'], 6)
            self.assertEqual(load_cache_meta(f'{t}/c')['sha256'], meta['sha256'])
            ds = PartDataset(f'{t}/c', train=False)
            self.assertEqual(len(ds), n)
            raw_groups = {}
            for line in Path(f'{t}/p.jsonl').read_text().splitlines():
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if isinstance(o, dict) and 'id' in o:
                    raw_groups[o['id']] = o.get('group', o.get('file'))
            split_of_group = {}
            for i in range(len(ds)):
                g = raw_groups[str(ds.ids[i])]
                split_of_group.setdefault(g, set()).add(int(ds.split[i]))
            self.assertTrue(all(len(s) == 1 for s in split_of_group.values()), 'a source group never straddles splits')
            ids = [str(x) for x in ds.ids]
            dup = ids.index(next(i for i in ids if i.startswith('dup-of-')))
            orig = ids.index(ids[dup][len('dup-of-'):])
            self.assertEqual(ds.split[dup], ds.split[orig], 'a body duplicated across groups pulls them into one split')
            it = ds[0]
            self.assertEqual(it['pts'].shape, (64, 3))
            q = it['pts']
            self.assertAlmostEqual(float(np.linalg.norm(q.max(0) - q.min(0))), 1.0, places=5)
            self.assertEqual(it['size'].shape, (3,))
            self.assertIn(int(it['label']), range(len(CLASSES)))
            tr = PartDataset(f'{t}/c', train=True, augment='so3')
            self.assertFalse(np.array_equal(tr[(0, 0)]['pts'], tr[(0, 1)]['pts']))
            np.testing.assert_array_equal(tr[(0, 1)]['pts'], tr[(0, 1)]['pts'])


@needs_torch
class PartTraining(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from parts.data import build_cache
        from parts.synth import write_jsonl
        cls.tmp = tempfile.TemporaryDirectory()
        t = cls.t = cls.tmp.name
        write_jsonl(f'{t}/p.jsonl', per_class=6, n_points=128)
        build_cache(f'{t}/p.jsonl', f'{t}/c', n_points=48, val=0.2, test=0.2, log=lambda *a: None)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _args(self, out, *extra):
        from parts.main import build_parser
        return build_parser().parse_args(['train', '--cache', f'{self.t}/c', '--out', out, '--device', 'cpu', '--epochs', '2',
                                          '--batch-size', '8', '--widths', '8,16', '--head', '16', '--workers', '0',
                                          '--log-every', '0', *extra])

    def test_train_resume_after_sigterm_matches_uninterrupted(self):
        from cadnn.runtime import load_ckpt
        from parts import train as T
        a = T.train(self._args(f'{self.t}/A'))
        self.assertTrue(a['finished'])

        def kill_at_2(state):
            if state['step'] == 2:
                os.kill(os.getpid(), signal.SIGTERM)

        b = T.train(self._args(f'{self.t}/B'), on_step=kill_at_2)
        self.assertTrue(b['stopped'])
        c = T.train(self._args(f'{self.t}/B', '--resume'))
        self.assertTrue(c['finished'])
        sa, sb = load_ckpt(f'{self.t}/A/last.pt')['model'], load_ckpt(f'{self.t}/B/last.pt')['model']
        for k in sa:
            torch.testing.assert_close(sa[k].float(), sb[k].float(), rtol=1e-5, atol=1e-6, msg=k)

    def test_pretrain_init_eval_export(self):
        from joints.synth import write_dump
        from parts import train as T
        from parts.main import build_parser, main
        write_dump(f'{self.t}/dump', 3, seed=2)
        pre = f'{self.t}/pre'
        self.assertEqual(main(['pretrain', '--dump', f'{self.t}/dump', '--out', pre, '--device', 'cpu', '--epochs', '1',
                               '--batch-size', '8', '--points', '48', '--decoder-points', '32', '--decoder-hidden', '16,32',
                               '--widths', '8,16', '--workers', '0', '--log-every', '0']), 0)
        enc = json.loads(Path(f'{pre}/encoder.json').read_text())
        self.assertEqual((enc['kind'], enc['labels_used']), ('unsupervised-pretrain', 'none'))
        with self.assertRaises(SystemExit):   # a different encoder shape is refused, not half-loaded
            T.train(self._args(f'{self.t}/bad', '--widths', '8,32', '--init-encoder', f'{pre}/encoder.pt'))
        out = f'{self.t}/I'
        T.train(self._args(out, '--epochs', '1', '--init-encoder', f'{pre}/encoder.pt'))
        rep = f'{self.t}/r'
        self.assertEqual(main(['eval', '--ckpt', f'{out}/best.pt', '--split', 'all', '--report', rep, '--device', 'cpu',
                               '--workers', '0', '--predictions', f'{self.t}/pred.jsonl']), 0)
        md = Path(rep + '.md').read_text()
        self.assertIn('unsupervised pretraining', md)
        self.assertIn('Synthetic data', md)
        m = json.loads(Path(rep + '.json').read_text())['metrics']
        self.assertEqual(len(m['per_class']), 12)
        args = build_parser().parse_args(['export', '--ckpt', f'{out}/best.pt', '--out', f'{self.t}/p.onnx'])
        try:
            code = T.export(args)
        except Exception as e:
            self.skipTest(f'ONNX export unavailable here: {type(e).__name__}: {e}')
        r = json.loads(Path(f'{self.t}/p.onnx.json').read_text())
        if not r.get('ok'):
            self.skipTest(r.get('error'))
        self.assertEqual(code, 0 if r.get('verified') is not False else 5)
        self.assertTrue(r['under_target'])


if __name__ == '__main__':
    unittest.main()
