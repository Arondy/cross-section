import * as THREE from 'three';
import {
  lineFromPoints,
  planeAxes,
  planeEdgePoints,
  sectionPolygon,
  v3,
  type Plane,
  type Vec3,
} from './geometry';
import { COLOR, PALETTE, cssColor } from './colors';
import type { Doc, LineObj, PlaneObj, PointObj, SceneObj, SegmentObj } from './model';

export type PickResult =
  | { type: 'face'; point: Vec3; faceIndex: number }
  | { type: 'none' };

export const toV = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

function pickColor(colors: readonly number[], index: number): number {
  return colors[index % colors.length];
}

export function fatLine(a: THREE.Vector3, b: THREE.Vector3, color: number, width: number) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(width, width, len, 12);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.renderOrder = 6;
  return mesh;
}

function tag(obj: SceneObj, obj3d: THREE.Object3D, part: string, pickable = true): THREE.Object3D {
  obj3d.userData.objId = obj.id;
  obj3d.userData.objKind = obj.kind;
  obj3d.userData.part = part;
  obj3d.userData.pickable = pickable;
  return obj3d;
}

function buildPoint(obj: PointObj, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(toV(obj.p));
  const r = selected ? 0.055 : 0.038;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(r, 20, 14),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(obj.color),
      depthTest: false,
      transparent: true,
    })
  );
  sphere.renderOrder = 7;
  g.add(tag(obj, sphere, 'body'));
  if (selected) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.085, 0.008, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
    );
    ring.renderOrder = 8;
    g.add(ring);
  }
  const label = makeLabel(obj.name, '#ffffff', 0.16);
  label.position.set(0.1, 0.1, 0);
  g.add(label);
  return g;
}

/**
 * Концы отрезка или прямой: одинаковые у обоих, различается только то, что у
 * прямой они лежат на бесконечной линии, а у отрезка ограничивают её.
 */
function buildEnds(
  obj: LineObj | SegmentObj,
  a: THREE.Vector3,
  b: THREE.Vector3,
  color: number,
  labelColor: string,
  selected: boolean
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const [p, part] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.05 : 0.032, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    knob.position.copy(p);
    knob.renderOrder = 7;
    out.push(tag(obj, knob, part));
  }
  const label = makeLabel(obj.name, labelColor, 0.15);
  label.position
    .copy(a.clone().add(b).multiplyScalar(0.5))
    .add(new THREE.Vector3(0.06, 0.09, 0.06));
  out.push(label);
  return out;
}

function buildLine(obj: LineObj, index: number, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  const a = toV(obj.a);
  const b = toV(obj.b);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const color = pickColor(PALETTE.line, index);
  const width = selected ? 0.016 : 0.009;

  // Цилиндр единичной длины: его растягивает `Viewer.fitLines` под текущий
  // кадр, иначе прямая обрывалась бы по хорде куба там, где до края экрана ещё
  // далеко, и пересечение двух прямых нельзя было бы ни увидеть, ни построить.
  const seg = fatLine(toV(v3(0, -0.5, 0)), toV(v3(0, 0.5, 0)), color, width);
  seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.add(tag(obj, seg, 'line'));
  // Прямая, по которой строится цилиндр, и сам цилиндр: их `Viewer` ищет здесь,
  // поэтому обрезка и растягивание идут по одному отрезку. Отсечения едут вместе
  // с объектом - иначе обрезанный хвост снова нарисовался бы.
  g.userData.lineRef = lineFromPoints(obj.a, obj.b);
  g.userData.lineMesh = seg;
  g.userData.lineCut = { a: obj.a, b: obj.b, trim: obj.trim };
  g.add(fatLine(a, b, 0xffffff, 0.004));
  g.add(...buildEnds(obj, a, b, color, cssColor(COLOR.line), selected));
  return g;
}

/**
 * Отрезок рисуется ровно между своими концами и не растягивается: в этом его
 * смысл. `lineRef` сюда не кладётся, поэтому `Viewer.fitLines` его не трогает.
 */
function buildSegment(obj: SegmentObj, index: number, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  const a = toV(obj.a);
  const b = toV(obj.b);
  const color = pickColor(PALETTE.segment, index);
  const width = selected ? 0.016 : 0.009;
  g.add(tag(obj, fatLine(a, b, color, width), 'line'));
  g.add(...buildEnds(obj, a, b, color, cssColor(COLOR.segment), selected));
  return g;
}

function planeBasis(pl: Plane): { origin: THREE.Vector3; u: THREE.Vector3; w: THREE.Vector3 } {
  const n = toV(pl.n);
  const { u, w } = planeAxes(pl);
  return { origin: n.clone().multiplyScalar(pl.d), u: toV(u), w: toV(w) };
}

/**
 * Отсекающие плоскости, совпадающие с самой плоскостью объекта, убираются.
 *
 * Лист обрезается полупространствами граней куба, а при совпадении с гранью
 * расстояние до её clip-плоскости равно нулю: фрагменты по краю случайно то
 * режутся, то нет, и плоскость покрывается крапом, хотя сечение построено
 * верно. Остальные пять полупространств лист по-прежнему держат в габарите
 * куба, поэтому он не выходит за пределы.
 */
function clipForPlane(pl: Plane, clip: THREE.Plane[]): THREE.Plane[] {
  const n = toV(pl.n);
  return clip.filter((cp) => {
    const k = cp.normal.dot(n);
    if (Math.abs(Math.abs(k) - 1) > 1e-3) return true;
    // Грань, параллельная плоскости, лежит на ней, только если её знак
    // совпадает: иначе это грань с противоположной стороны куба.
    const s = k > 0 ? pl.d : -pl.d;
    return Math.abs(s + cp.constant) > 1e-3;
  });
}

function buildPlane(obj: PlaneObj, index: number, selected: boolean, clip: THREE.Plane[]): THREE.Group {
  const g = new THREE.Group();
  const color = pickColor(PALETTE.plane, index);
  const poly = sectionPolygon(obj.plane);
  const { origin, u, w } = planeBasis(obj.plane);

  const size = 1.9;
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 2, size * 2),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: selected ? 0.22 : 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
      // Плоскость, совпавшая с гранью, идёт ровно по её поверхности. Смещение
      // в сторону камеры убирает спор двух поверхностей в буфере глубины: без
      // него грань местами перехватывает лист, и та же самая плоскость
      // выглядит то своей, то чужой.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      clippingPlanes: clipForPlane(obj.plane, clip),
      clipIntersection: false,
    })
  );
  sheet.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(u, w, toV(obj.plane.n))
  );
  sheet.position.copy(origin);
  sheet.renderOrder = 3;
  g.add(tag(obj, sheet, 'sheet', false));

  if (poly.length >= 3) {
    const verts: number[] = [];
    for (const p of poly) verts.push(p.x, p.y, p.z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const idx: number[] = [];
    for (let i = 1; i + 1 < poly.length; i++) idx.push(0, i, i + 1);
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: selected ? 0.4 : 0.28,
        side: THREE.DoubleSide,
        depthTest: false,
      })
    );
    fill.renderOrder = 5;
    g.add(tag(obj, fill, 'fill', false));
  }

  const hits = planeEdgePoints(obj.plane);
  hits.forEach((p, i) => {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.032 : 0.024, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x1b1b1b, depthTest: false })
    );
    dot.position.copy(toV(p));
    dot.renderOrder = 9;
    g.add(tag(obj, dot, `hit${i}`, false));
    if (selected) {
      const label = makeLabel(`M${i + 1}`, '#111111', 0.1);
      label.position.copy(toV(p)).add(new THREE.Vector3(0.07, 0.07, 0.07));
      g.add(label);
    }
  });
  return g;
}

const LABEL_FONT = '"Segoe UI", system-ui, sans-serif';
/** Буферных пикселей на единицу мира в стандартном виде при высоте окна 1024. */
const LABEL_PX_PER_UNIT = 175;
/**
 * Запас под приближение камеры: текстура вдвое крупнее подписи на экране, и
 * мипмап первого уровня попадает в экран ровно один к одному.
 */
const LABEL_SS = 2;
const measurer = document.createElement('canvas').getContext('2d')!;

/**
 * Подпись объекта: спрайт с текстом на canvas.
 *
 * Канва рисуется под тот размер, в какой подпись стоит на экране, а не в
 * фиксированных 256x96. Раньше текстура была втрое крупнее подписи, и мипмапы
 * усредняли буквы до каши; теперь она попадает в экран один к одному, поэтому
 * шрифт остаётся резким на любом расстоянии до камеры.
 *
 * У вариантов своя геометрия, и это важно: спрайт показывает текстуру в пропорциях
 * квада, поэтому квад должен повторять пропорции канвы. Иначе буква растягивается
 * по одной оси и выглядит размытой. `boxed` рисует тёмную подложку под текстом,
 * без неё подпись идёт прямо цветом, как у осей координат.
 */
export function makeLabel(
  text: string,
  color: string,
  scale: number,
  boxed = true
): THREE.Sprite {
  // Высота подписи зависит от высоты окна и от плотности пикселей, поэтому
  // канва считается от них, а не задаётся константой.
  const unit =
    LABEL_PX_PER_UNIT *
    (window.innerHeight / 1024) *
    Math.min(window.devicePixelRatio, 2);
  // Буква занимает часть высоты подписи: у коробки она ниже, потому что сверху и
  // снизу ещё идёт поле, у осей координат готова занять всю.
  const font = Math.max(10, Math.round(scale * unit * LABEL_SS * (boxed ? 0.45 : 0.75)));
  measurer.font = `bold ${font}px ${LABEL_FONT}`;
  const textW = Math.ceil(measurer.measureText(text).width);
  // Подложка занимает всю канву, а поля уходят внутрь неё. Если вычесть их из
  // ширины подложки, она схлопнется до ширины буквы и затенения не будет видно.
  const padX = Math.round(font * (boxed ? 0.27 : 0.12));
  const w = textW + padX * 2;
  const boxH = Math.round(font * 1.17);
  const h = Math.round(font * (boxed ? 1.9 : 1.25));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `bold ${font}px ${LABEL_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (boxed) {
    ctx.fillStyle = 'rgba(16, 24, 32, 0.78)';
    roundRect(ctx, 0, (h - boxH) / 2, w, boxH, Math.round(boxH * 0.26));
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Анизотропия нужна подписям на самом кубе: они стоят под углом к камере, и
  // без неё мипмап берётся по худшей оси и текст мылится сильнее, чем может.
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  // Квад повторяет пропорции канвы, иначе буква растянется по одной из осей.
  sprite.scale.set(scale * (w / h), scale, 1);
  sprite.renderOrder = 11;
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function buildScene(doc: Doc, selection: string[], clip: THREE.Plane[]): THREE.Group {
  const group = new THREE.Group();
  // Индексы нумеруют объекты каждого вида отдельно, чтобы цвета не повторялись
  // у соседей одного вида.
  const idx: Record<SceneObj['kind'], number> = { point: 0, line: 0, segment: 0, plane: 0 };
  for (const obj of doc.objects) {
    if (!obj.visible) continue;
    const selected = selection.includes(obj.id);
    const index = idx[obj.kind]++;
    if (obj.kind === 'point') group.add(buildPoint(obj, selected));
    else if (obj.kind === 'line') group.add(buildLine(obj, index, selected));
    else if (obj.kind === 'segment') group.add(buildSegment(obj, index, selected));
    else group.add(buildPlane(obj, index, selected, clip));
  }
  return group;
}
