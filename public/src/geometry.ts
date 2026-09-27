export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const eq = (a: Vec3, b: Vec3, eps = 1e-6): boolean => dist(a, b) < eps;

export function norm(a: Vec3): Vec3 | null {
  const l = len(a);
  return l < 1e-9 ? null : mul(a, 1 / l);
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export function fmt(p: Vec3, digits = 3): string {
  const r = (n: number) => {
    const s = n.toFixed(digits);
    return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
  };
  return `(${r(p.x)}, ${r(p.y)}, ${r(p.z)})`;
}

export const HALF = 1;

export const VERTICES: Vec3[] = [];
for (const x of [-HALF, HALF])
  for (const y of [-HALF, HALF])
    for (const z of [-HALF, HALF]) VERTICES.push(v3(x, y, z));

// Квад грани обязан лежать в её же плоскости: иначе подсветка горит на одной
// грани, а куб нарисован на другой. Порядок вершин идёт по кругу, иначе
// треугольники сложатся в «бабочку».
export const FACES: { normal: Vec3; quad: number[] }[] = [
  { normal: v3(0, 0, 1), quad: [1, 3, 7, 5] },
  { normal: v3(0, 0, -1), quad: [0, 2, 6, 4] },
  { normal: v3(0, 1, 0), quad: [2, 3, 7, 6] },
  { normal: v3(0, -1, 0), quad: [0, 1, 5, 4] },
  { normal: v3(1, 0, 0), quad: [4, 5, 7, 6] },
  { normal: v3(-1, 0, 0), quad: [0, 1, 3, 2] },
];

export const FACE_NAMES = ['z = +1', 'z = −1', 'y = +1', 'y = −1', 'x = +1', 'x = −1'];

export const EDGES: [number, number][] = [];
for (let i = 0; i < 8; i++)
  for (let j = i + 1; j < 8; j++) {
    const dx = VERTICES[i].x !== VERTICES[j].x ? 1 : 0;
    const dy = VERTICES[i].y !== VERTICES[j].y ? 1 : 0;
    const dz = VERTICES[i].z !== VERTICES[j].z ? 1 : 0;
    if (dx + dy + dz === 1) EDGES.push([i, j]);
  }

export interface Plane {
  n: Vec3;
  d: number;
}

export interface Line3 {
  p: Vec3;
  dir: Vec3;
}

/** Сторона прямой, с которой снимается хвост. */
export type TrimEnd = 'start' | 'end';

/**
 * Отсечения прямой, по одному на сторону. Хвост снимается только с той стороны,
 * где отмечена точка, поэтому у прямой их два независимых отсечения.
 */
export interface Trims {
  start?: Vec3;
  end?: Vec3;
}

/** Прямая с её отсечениями: нужны оба конца, они и есть её определение. */
export interface Cut {
  a: Vec3;
  b: Vec3;
  trim?: Trims;
}

export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = norm(cross(sub(b, a), sub(c, a)));
  if (!n) return null;
  return { n, d: dot(n, a) };
}

export const planeSigned = (pl: Plane, p: Vec3): number => dot(pl.n, p) - pl.d;

export function lineFromPoints(a: Vec3, b: Vec3): Line3 | null {
  const dir = norm(sub(b, a));
  return dir ? { p: clone(a), dir } : null;
}

/**
 * Полупространство в виде, который считает `THREE.Plane`: точка p внутри,
 * когда dot(n, p) + d >= 0. Плоскости пирамиды камеры переносятся сюда
 * без смены знака, поэтому обрезка прямой идёт по тому же правилу, по
 * которому three считает расстояние до плоскости.
 */
export interface HalfSpace {
  n: Vec3;
  d: number;
}

/**
 * Отрезок прямой, попадающий внутрь всех полупространств, то есть её часть
 * внутри пирамиды камеры. Прямая рисуется и прилипает по этому отрезку, а не
 * по хорде куба: иначе она обрывается там, где до края экрана ещё далеко,
 * и пересечение двух прямых нельзя ни увидеть, ни построить в нём точку.
 *
 * Параметр t отсчитывается вдоль единичного направления l.dir, поэтому его
 * значения годятся и для длины отрезка, и для его середины.
 */
export function lineChordInHalfspaces(
  l: Line3,
  spaces: readonly HalfSpace[]
): [Vec3, Vec3] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const s of spaces) {
    const denom = dot(s.n, l.dir);
    const base = dot(s.n, l.p) + s.d;
    if (Math.abs(denom) < 1e-9) {
      // Прямая параллельна плоскости: она либо целиком внутри, либо целиком
      // снаружи, и в первом случае отрезок эта плоскость не ограничивает.
      if (base < 0) return null;
      continue;
    }
    const t = -base / denom;
    // Точка внутри, когда base + t * denom >= 0, поэтому знак denom решает,
    // с какой стороны ограничивается параметр.
    if (denom > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  if (t1 < t0) return null;
  return [add(l.p, mul(l.dir, t0)), add(l.p, mul(l.dir, t1))];
}

/**
 * Все грани куба, на которых лежит точка. Точка на ребре принадлежит двум
 * граням, вершина - трём, поэтому одиночного индекса для проверки соседей не
 * хватает: цепочку сечения можно вести через ребро, и обе грани на счётчике.
 *
 * Проверяется куб целиком, как в `faceOf`: точка в плоскости грани, но за её
 * краем, ни на какой грани не лежит, иначе цепочка приняла бы её соседом.
 */
export function pointFaces(p: Vec3, eps = 1e-4): number[] {
  if (!insideCube(p, eps)) return [];
  const out: number[] = [];
  for (let i = 0; i < 6; i++) if (Math.abs(dot(FACES[i].normal, p) - HALF) < eps) out.push(i);
  return out;
}

/**
 * Грань куба, на которой лежит точка, или `null` вне граней.
 *
 * Проверяется куб целиком, а не одна плоскость грани: точка на прямой, ушедшей
 * за пределы куба, лежит в плоскости грани и за её краем, и такая подсветка
 * вводила бы в заблуждение - точка стоит в стороне, а горит не та грань.
 *
 * Индекс приводится к `null` прямо здесь, на границе модуля: `FACES[-1].normal`
 * уронил бы обработчик превью вместе со всей отрисовкой.
 */
export function faceOf(p: Vec3, eps = 1e-4): number | null {
  if (!insideCube(p, eps)) return null;
  for (let i = 0; i < 6; i++) if (Math.abs(dot(FACES[i].normal, p) - HALF) < eps) return i;
  return null;
}

/**
 * Внутри ли точка куба, включая грани, рёбра и вершины.
 *
 * `faceOf` проверяет куб, а не только плоскость грани, поэтому признак
 * «касается ли куба» и признак «лежит ли на грани» у них совпадают.
 */
export function insideCube(p: Vec3, eps = 1e-4): boolean {
  return (
    Math.abs(p.x) <= HALF + eps &&
    Math.abs(p.y) <= HALF + eps &&
    Math.abs(p.z) <= HALF + eps
  );
}

export function projectToFaceQuad(p: Vec3, faceIndex: number): Vec3 {
  const n = FACES[faceIndex].normal;
  const q = v3(p.x, p.y, p.z);
  if (n.x !== 0) q.x = HALF * Math.sign(n.x);
  else if (n.y !== 0) q.y = HALF * Math.sign(n.y);
  else q.z = HALF * Math.sign(n.z);
  q.x = Math.max(-HALF, Math.min(HALF, q.x));
  q.y = Math.max(-HALF, Math.min(HALF, q.y));
  q.z = Math.max(-HALF, Math.min(HALF, q.z));
  return q;
}

export type SnapKind = 'none' | 'edge' | 'vertex';

export function snapToCube(
  p: Vec3,
  threshold = 0.14
): { p: Vec3; kind: SnapKind } {
  let best: Vec3 | null = null;
  let bestD = threshold;
  for (const vertex of VERTICES) {
    const d = dist(p, vertex);
    if (d < bestD) {
      bestD = d;
      best = vertex;
    }
  }
  if (best) return { p: clone(best), kind: 'vertex' };

  for (const [i, j] of EDGES) {
    const a = VERTICES[i];
    const b = VERTICES[j];
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
    const proj = add(a, mul(ab, t));
    const d = dist(p, proj);
    if (d < bestD) {
      bestD = d;
      best = proj;
    }
  }
  if (best) return { p: clone(best), kind: 'edge' };
  return { p: clone(p), kind: 'none' };
}

/**
 * Добавляет точку, если рядом такой же точки ещё нет. Одна вершина куба лежит
 * сразу на нескольких рёбрах, поэтому без проверки сечение насчитало бы лишние
 * вершины.
 */
function pushUnique(out: Vec3[], p: Vec3): void {
  if (!out.some((q) => eq(p, q, 1e-5))) out.push(p);
}

export function planeEdgePoints(pl: Plane): Vec3[] {
  const found: Vec3[] = [];
  for (const [i, j] of EDGES) {
    const a = VERTICES[i];
    const b = VERTICES[j];
    const fa = planeSigned(pl, a);
    const fb = planeSigned(pl, b);
    if (Math.abs(fa) < 1e-9) found.push(clone(a));
    else if (Math.abs(fb) < 1e-9) found.push(clone(b));
    else if (fa * fb < 0) found.push(lerp(a, b, fa / (fa - fb)));
  }
  const out: Vec3[] = [];
  for (const p of found) pushUnique(out, p);
  return out;
}

/**
 * Ортонормированный базис плоскости: `u` и `w` лежат в ней, `n × u = w`.
 *
 * Опорная ось выбирается по наименьшему модулю компоненты. Сумма «подходящих»
 * осей здесь не годится: у диагональной нормали `(1, 1, 1)` подходят сразу все
 * три, сумма параллельна нормали, её проекция - ноль, и базис вырождается. Three
 * не сообщает об этом: `setFromRotationMatrix` строит из вырожденной матрицы
 * корректный по модулю, но случайный поворот, и плоскость уезжает из своей
 * плоскости. Минимальная по модулю компонента от этого защищает: ненулевая она
 * всегда, иначе на её месте была бы единичная.
 */
export function planeAxes(pl: Plane): { u: Vec3; w: Vec3 } {
  const abs = [Math.abs(pl.n.x), Math.abs(pl.n.y), Math.abs(pl.n.z)];
  const k = abs[0] <= abs[1] && abs[0] <= abs[2] ? 0 : abs[1] <= abs[2] ? 1 : 2;
  const seed = v3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
  const u = norm(cross(pl.n, seed))!;
  return { u, w: cross(pl.n, u) };
}

export function sectionPolygon(pl: Plane): Vec3[] {
  const pts = planeEdgePoints(pl);
  if (pts.length < 3) return [];
  const c = mul(
    pts.reduce((s, p) => add(s, p), v3(0, 0, 0)),
    1 / pts.length
  );
  const { u, w } = planeAxes(pl);
  return pts.slice().sort((p, q) => {
    const dp = sub(p, c);
    const dq = sub(q, c);
    return Math.atan2(dot(dp, w), dot(dp, u)) - Math.atan2(dot(dq, w), dot(dq, u));
  });
}

/**
 * Ближайшая к лучу точка отрезка прямой и расстояние до луча.
 *
 * Минимум расстояния между лучом и отрезком находится из системы
 *   (A·t − B·s) = −D
 *   (B·t − C·s) = −E
 * где A, B, C — скалярные произведения направлений, D и E — проекции
 * вектора «от начала отрезка до начала луча». Решается точно, поэтому
 * доступно любое место прямой, а не отдельные ступеньки от перебора отсчётов.
 */
export function closestPointOnSegmentToRay(
  rayOrigin: Vec3,
  rayDir: Vec3,
  a: Vec3,
  b: Vec3
): { p: Vec3; d: number } {
  const u = sub(b, a);
  const uu = dot(u, u);
  if (uu < 1e-12) {
    return { p: clone(a), d: distToRay(a, rayOrigin, rayDir) };
  }
  const w0 = sub(a, rayOrigin);
  const A = dot(rayDir, rayDir);
  const B = dot(rayDir, u);
  const C = uu;
  const D = dot(rayDir, w0);
  const E = dot(u, w0);
  const det = A * C - B * B;

  let t: number;
  let s: number;
  if (Math.abs(det) < 1e-12) {
    // Луч параллелен отрезку: параметр s не определяется, берём ближайший конец.
    const dA = distToRay(a, rayOrigin, rayDir);
    const dB = distToRay(b, rayOrigin, rayDir);
    return dA <= dB ? { p: clone(a), d: dA } : { p: clone(b), d: dB };
  }

  t = (D * C - B * E) / det;
  s = (-A * E + B * D) / det;

  // Параметр точки вне отрезка прижимается к концу, после чего t
  // пересчитывается: иначе расстояние берётся не из той точки.
  if (s < 0 || s > 1) {
    s = s < 0 ? 0 : 1;
    t = (D + B * s) / A;
  }
  if (t < 0) {
    t = 0;
    s = C < 1e-12 ? 0 : E / C;
    s = Math.max(0, Math.min(1, s));
  }
  const p = add(a, mul(u, s));
  return { p, d: distToRay(p, rayOrigin, rayDir) };
}

export function distToRay(p: Vec3, origin: Vec3, dir: Vec3): number {
  const t = Math.max(0, dot(sub(p, origin), dir));
  return dist(p, add(origin, mul(dir, t)));
}

export function lineIntersect(l1: Line3, l2: Line3): Vec3 | null {
  const n = cross(l1.dir, l2.dir);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const w = sub(l2.p, l1.p);
  const t = dot(cross(w, l2.dir), n) / nn;
  return add(l1.p, mul(l1.dir, t));
}

/**
 * Пересечение прямой с отрезком, если оно попадает внутрь отрезка.
 *
 * Отличается от `lineIntersect` проверкой принадлежности: прямая, пересекающая
 * продолжение ребра, с ребром не пересекается. На этом стоит прилипание к
 * ребру куба - без него точка на прямой у края не находила бы общую грань и
 * цепочка сечения не замыкалась бы.
 *
 * Проверяется сама точка, а не параметр вдоль ребра. Формулы для `t` и `s`
 * получены проекцией на общее перпендикулярное, поэтому верны только когда
 * прямые компланарны, а у скрещивающихся они дают правдоподобное число: прямая
 * вдоль оси X мимо рёбер, параллельных ей, получала пересечение с каждым из них
 * и на хвосте получались фантомные точки, которые ничего не отсекали.
 */
export function lineSegmentHit(l: Line3, a: Vec3, b: Vec3): Vec3 | null {
  const u = sub(b, a);
  const n = cross(l.dir, u);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const w = sub(a, l.p);
  const t = dot(cross(w, u), n) / nn;
  const p = add(l.p, mul(l.dir, t));
  return pointOnSegment(p, a, b, 1e-6) ? p : null;
}

/**
 * Границы того, что отсекать нельзя: отрезок между опорными точками прямой и
 * хорда куба, если прямая через него проходит. За этими границами начинаются
 * хвосты, и только они отсекаются.
 */
function untrimmable(l: Line3, b: Vec3): [number, number] {
  const t = (p: Vec3) => dot(sub(p, l.p), l.dir);
  // Точка `b` не обязана лежать на параметре 1: параметр вдоль прямой измерен в
  // единицах длины, поэтому конец - это |b − a|. Считать его единицей нельзя,
  // иначе ядро перестаёт содержать `b` и отсечение отрезает её от прямой.
  let lo = 0;
  let hi = t(b);
  const hits = lineEdgeHits(l);
  if (hits.length >= 2) {
    // Крайние точки хорды: у прямой вдоль ребра или в плоскости грани
    // пересечений больше двух, и берутся только самые дальние.
    const ts = hits.map(t).sort((x, y) => x - y);
    lo = Math.min(lo, ts[0]);
    hi = Math.max(hi, ts[ts.length - 1]);
  }
  return [lo, hi];
}

/**
 * Отрезок, остающийся от прямой после отсечения.
 *
 * `base` - полный отрезок прямой на экране, обычно хорда кадра. Сторона без
 * отсечения остаётся в `base` целиком: отсечение трогает только ту сторону, где
 * стоит точка.
 *
 * Точка отсечения не должна утащить прямую внутрь ядра, поэтому граница берётся
 * в сторону от ядра: `min` для начала, `max` для конца. Точка снаружи режет
 * ровно по себе, а точка внутри ядра оставляет отрезок нетронутым.
 */
export function trimmedSpan(base: [Vec3, Vec3], cut?: Cut): [Vec3, Vec3] {
  if (!cut?.trim) return base;
  const l = lineFromPoints(cut.a, cut.b);
  if (!l) return base;
  const t = (p: Vec3) => dot(sub(p, l.p), l.dir);
  const [lo, hi] = untrimmable(l, cut.b);
  const start = cut.trim.start ? Math.min(lo, t(cut.trim.start)) : Math.min(lo, t(base[0]));
  const end = cut.trim.end ? Math.max(hi, t(cut.trim.end)) : Math.max(hi, t(base[1]));
  return [add(l.p, mul(l.dir, start)), add(l.p, mul(l.dir, end))];
}

/**
 * С какой стороны прямой лежит точка: за началом, перед концом или между ними.
 * Определяет, какое из двух отсечений ей соответствует.
 */
export function trimEndOf(a: Vec3, b: Vec3, p: Vec3): TrimEnd | 'inside' {
  const l = lineFromPoints(a, b);
  if (!l) return 'inside';
  const t = dot(sub(p, l.p), l.dir);
  const [lo, hi] = untrimmable(l, b);
  if (t <= lo) return 'start';
  if (t >= hi) return 'end';
  return 'inside';
}

export function pointOnSegment(p: Vec3, a: Vec3, b: Vec3, eps = 1e-6): boolean {
  const u = sub(b, a);
  const uu = dot(u, u);
  if (uu < 1e-12) return dist(p, a) < eps;
  const s = dot(sub(p, a), u) / uu;
  if (s < -eps || s > 1 + eps) return false;
  return dist(p, add(a, mul(u, s))) < eps;
}

export function lineEdgeHits(l: Line3): Vec3[] {
  const out: Vec3[] = [];
  for (const [i, j] of EDGES) {
    const p = lineSegmentHit(l, VERTICES[i], VERTICES[j]);
    if (p) pushUnique(out, p);
  }
  return out;
}
