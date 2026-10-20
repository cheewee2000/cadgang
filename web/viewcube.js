/**
 * The view cube, lower right, as Bambu Studio has it: a cube that turns with the model, its faces
 * named (Front, Back, Right, Left, Top, Bottom), the x / y / z axes from its corner, and a fit
 * button beside it. Click a face for that view; an edge or a corner for the view between them.
 *
 * Its own small renderer and scene, so the main view's passes, picks and snapshots never see it.
 * Model frame: Z up, front looks along +Y (the camera at -Y), right is +X.
 */
const SIZE = 112;
const FACES = [   // BoxGeometry's material order, after it is turned Z-up: +x, -x, +z, -z, -y, +y
  'Right', 'Left', 'Top', 'Bottom', 'Front', 'Back',
];

export function createViewCube({ THREE, container, getCamera, onView, onFit }) {
  const wrap = Object.assign(document.createElement('div'), { className: 'viewcube' });
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(SIZE, SIZE);
  renderer.domElement.title = 'Click a face, an edge or a corner for that view';
  const fit = Object.assign(document.createElement('button'), { className: 'ghost viewcube-fit', title: 'Fit the model (F)' });
  fit.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M12 7.5l4 2.2v4.6l-4 2.2-4-2.2V9.7z"/><path d="M8 9.7l4 2.2 4-2.2M12 11.9v4.6"/></svg>';
  fit.addEventListener('click', () => onFit());
  wrap.append(renderer.domElement, fit);
  container.appendChild(wrap);

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1.25, 1.25, 1.25, -1.25, 0.1, 20);
  cam.position.set(0, 0, 6);
  scene.add(new THREE.AmbientLight(0xffffff, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 4); scene.add(sun);

  const rig = new THREE.Group();   // the model's frame, turned as the main camera sees it
  scene.add(rig);
  const label = (text) => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#d9d9d6'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#bdbcb7'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 124);
    g.fillStyle = '#3a3a38'; g.font = '600 26px -apple-system, Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 64, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const mats = FACES.map((f) => new THREE.MeshLambertMaterial({ map: label(f), transparent: true, opacity: 0.94 }));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.rotateX(Math.PI / 2);   // three's +Y up to the model's +Z up; the side labels read upright
  const cube = new THREE.Mesh(geo, mats);
  rig.add(cube);
  // axes from the cube's lower front left corner, as in Bambu: x red, y green, z blue
  const corner = new THREE.Vector3(-0.5, -0.5, -0.5);
  for (const [dir, color, name] of [[[1, 0, 0], 0xd0524c, 'x'], [[0, 1, 0], 0x6cba6a, 'y'], [[0, 0, 1], 0x6a6fd6, 'z']]) {
    const d = new THREE.Vector3(...dir);
    rig.add(new THREE.ArrowHelper(d, corner, 1.45, color, 0.14, 0.08));
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = `#${color.toString(16).padStart(6, '0')}`; g.font = '500 44px -apple-system, Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, 32, 34);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.scale.setScalar(0.32); s.position.copy(corner).addScaledVector(d, 1.65); rig.add(s);
  }

  // what a click means: a face, an edge or a corner, by how close the hit is to the cube's borders
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const EDGE = 0.32;   // within this of a border (cube half-size 0.5): the edge or corner
  function aim(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObject(cube)[0];
    if (!hit) return null;
    const p = cube.worldToLocal(hit.point.clone());
    const dir = new THREE.Vector3(...[p.x, p.y, p.z].map((v) => (Math.abs(v) > EDGE ? Math.sign(v) : 0)));
    return { dir: dir.normalize(), face: hit.face.materialIndex };
  }
  let hoverFace = -1;
  const paint = (i) => { if (i === hoverFace) return; if (hoverFace >= 0) mats[hoverFace].color.set(0xffffff); hoverFace = i; if (i >= 0) mats[i].color.set(0xbcd6ff); };
  renderer.domElement.addEventListener('pointermove', (e) => { paint(aim(e)?.face ?? -1); });
  renderer.domElement.addEventListener('pointerleave', () => paint(-1));
  renderer.domElement.addEventListener('click', (e) => { const a = aim(e); if (a) onView(a.dir); });

  const inv = new THREE.Quaternion();
  /** Each frame: turn the cube as the main camera sees the model, and draw it. */
  function render() {
    if (wrap.hidden) return;
    rig.quaternion.copy(inv.copy(getCamera().quaternion).invert());
    renderer.render(scene, cam);
  }
  return { render, el: wrap, set hidden(v) { wrap.hidden = v; } };
}
