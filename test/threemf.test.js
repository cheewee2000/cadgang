// A 3MF whose parts live in other model files (Bambu Studio, Orca, Fusion) opens: every file numbers its
// objects from 1, so they are told apart by the file they came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenParts } from '../web/vendor/jsm/loaders/3MFLoader.js';

test('objects in other model files are moved into the root, and what names them follows', () => {
  const mesh = (n) => ({ id: '1', mesh: { n } });
  const d = {
    rels: [{ target: '/3D/3dmodel.model' }],
    model: {
      '3D/3dmodel.model': {
        resources: { object: {
          2: { id: '2', components: [{ objectId: '1', path: '/3D/Objects/a.model' }] },
          4: { id: '4', components: [{ objectId: '1', path: '/3D/Objects/b.model' }, { objectId: '2', path: null }] },
        } },
        build: [{ objectId: '2', path: null }, { objectId: '4', path: null }, { objectId: '1', path: '/3D/Objects/b.model' }],
      },
      '3D/Objects/a.model': { resources: { object: { 1: mesh('a') } }, build: [] },
      '3D/Objects/b.model': { resources: { object: { 1: mesh('b'), 3: { id: '3', components: [{ objectId: '1', path: null }] } } }, build: [] },
    },
  };
  flattenParts(d);
  assert.deepEqual(Object.keys(d.model), ['3D/3dmodel.model']);
  const o = d.model['3D/3dmodel.model'].resources.object, of = (c) => o[c.objectId];
  assert.equal(of(o[2].components[0]).mesh.n, 'a');
  assert.equal(of(o[4].components[0]).mesh.n, 'b', 'the same number in another file is another object');
  assert.equal(of(o[4].components[1]), o[2], 'a component with no path is in its own file');
  assert.equal(of(o['3D/Objects/b.model#3'].components[0]).mesh.n, 'b', 'and that holds inside a part file too');
  assert.equal(of(d.model['3D/3dmodel.model'].build[2]).mesh.n, 'b', 'a build item can name a part file directly (Fusion)');
  assert.equal(o['3D/Objects/a.model#1'].id, '3D/Objects/a.model#1');
});
