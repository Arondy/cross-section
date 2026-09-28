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

export type SolidId = 'cube' | 'tetra' | 'box' | 'slant';

export const DEFAULT_SOLID: SolidId = 'cube';

/**
 * Грань: плоскость и вершины по кругу.
 *
 * Обход вершин идёт против часовой стрелки, если смотреть на грань снаружи, и
 * прижимание точки к грани считает именно по нему. Направление выводится в
 * `makeSolid`, а не пишется руками: у наклонных граней оно на глаз всегда
 * получается не тем, и грань подсвечивалась бы не с той стороны.
 */
export interface SolidFace {
  /** Подпись грани в сообщениях: `x = +1.4` у параллелепипеда, `ABD` у тетраэдра. */
  name: string;
  /** Нормаль наружу: вершины грани лежат в плоскости `dot(normal, p) = d`. */
  normal: Vec3;
  d: number;
  poly: number[];
}

/**
 * Описание грани на входе `buildSolid`.
 *
 * Подпись бывает двух видов: у грани, параллельной оси, она выводится из самой
 * плоскости (`x = +1.4`), у остальных задана буквами её вершин (`ABD`).
 * `byPlane` различает их, иначе сдвинутый угол оставил бы у грани имя прежней
 * фигуры: подпись `y = −1` у грани, уехавшей на `z = −1.4`.
 */
interface FaceSpec {
  poly: number[];
  letters?: string;
  byPlane?: boolean;
}

export interface Solid {
  id: SolidId;
  vertices: Vec3[];
  /** Грани в исходном виде: из них собирается та же фигура с другими вершинами. */
  specs: FaceSpec[];
  faces: SolidFace[];
  /** Рёбра: пары индексов вершин, каждое по одному разу. */
  edges: [number, number][];
  /** Углы фигуры: имя и индекс вершины. */
  corners: { name: string; index: number }[];
}

/**
 * Подпись грани, параллельной одной из осей: `x = +1.4`.
 *
 * Имя берётся у самой плоскости, а не у фигуры-образца: после сдвига угла грань
 * стоит на другом расстоянии, и подпись прежней фигуры стала бы враньём в
 * сообщении об ошибке. Для грани, утратившей параллельность оси, подписи по
 * плоскости нет вовсе, и возвращается `null` - тогда грань называется буквами
 * своих вершин, как у наклонного параллелепипеда.
 */
function planeFaceName(normal: Vec3, d: number): string | null {
  const parts = [normal.x, normal.y, normal.z];
  const a = parts.map(Math.abs);
  const axis = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
  if (a.reduce((s, x) => s + x, 0) - a[axis] > 1e-6) return null;
  // Знак берётся у положения грани, а не у `d`: `d` у внешней нормали всегда
  // положителен, и по нему обе противоположные грани назывались бы одинаково.
  const at = parts[axis] * d;
  // Расстояние приводится к трём знакам: без этого куб называл бы свои грани
  // `x = +0.9999999999999999` вместо `x = +1`, и подпись расползлась бы с той же
  // арифметикой, что и в полях координат.
  return `${'xyz'[axis]} = ${at < 0 ? '−' : '+'}${Math.round(Math.abs(at) * 1000) / 1000}`;
}

/**
 * Фигура собирается из вершин и граней, а нормали и рёбра выводятся из них.
 *
 * Нормаль берётся из первых трёх вершин грани и разворачивается наружу от
 * центра фигуры, обход доворачивается до правильного. Так грань не может
 * оказаться в плоскости другой грани или с вывернутой вершиной - у куба обе
 * ошибки выглядели одинаково: подсветка горела не там, чертёж был верный.
 * Рёбер отдельно нет: они идут по кругу граней, иначе список рёбер разошёлся
 * бы с набором граней.
 *
 * Отказ возвращается значением, а не исключением: сдвинутый угол может выродить
 * грань, и ронять из-за этого приложение нельзя - движок откатит угол обратно.
 */
function buildSolid(
  id: SolidId,
  vertices: Vec3[],
  specs: FaceSpec[],
  corners: { name: string; index: number }[]
): Solid | null {
  const center = centerOf(vertices);
  const faces: SolidFace[] = [];
  for (const spec of specs) {
    const [a, b, c] = spec.poly;
    const winding = norm(cross(sub(vertices[b], vertices[a]), sub(vertices[c], vertices[a])));
    if (!winding) return null;
    const inward = dot(winding, sub(vertices[a], center)) < 0;
    const normal = inward ? mul(winding, -1) : winding;
    const d = dot(normal, vertices[a]);
    faces.push({
      name: (spec.byPlane ? planeFaceName(normal, d) : null) ?? spec.letters ?? '',
      normal,
      d,
      poly: inward ? spec.poly.slice().reverse() : spec.poly,
    });
  }
  const edges: [number, number][] = [];
  for (const face of faces) {
    face.poly.forEach((i, k) => {
      const j = face.poly[(k + 1) % face.poly.length];
      const pair: [number, number] = i < j ? [i, j] : [j, i];
      if (!edges.some(([x, y]) => x === pair[0] && y === pair[1])) edges.push(pair);
    });
  }
  return { id, vertices, specs, faces, edges, corners };
}

/**
 * Причина, по которой из вершин не получилась фигура: угол притащил к соседнему,
 * грань выродилась в прямую, фигура вывернулась наизнанку или легла в плоскость.
 *
 * Отказы различаются, потому что лечатся по-разному: от схлопывания уводят
 * назад по той же оси, от выворота - возвратом на исходное место.
 */
export type SolidFault = 'coincident' | 'flatFace' | 'inverted' | 'collapsed';

/** Собранная фигура вместе с вершинами, из которых она вышла. */
export type SolidFit =
  | { ok: true; solid: Solid }
  | { ok: false; fault: SolidFault };

/**
 * Та же фигура с другими вершинами: грани, нормали, рёбра и подписи собираются
 * заново, поэтому из куба получается параллелепипед, а не куб с выбитым углом.
 *
 * Пока вершины не сдвинули, отдаётся та же ссылка, что у фигуры-образца:
 * `Viewer.setSolid` сравнивает по ссылке, и новый объект на каждый чих заставил
 * бы пересобирать сцену целиком.
 *
 * Чужие вершины не подойдут даже по числу: у фигуры своя разметка граней, и
 * вершина чужой фигуры означала бы другую грань.
 */
export function reshapeSolid(base: Solid, vertices: Vec3[]): SolidFit {
  if (vertices.length !== base.vertices.length) return { ok: false, fault: 'flatFace' };
  const shape = buildSolid(base.id, vertices, base.specs, base.corners);
  if (!shape) return { ok: false, fault: 'flatFace' };
  const fault = solidFault(shape);
  return fault ? { ok: false, fault } : { ok: true, solid: shape };
}

/**
 * Фигура из вершин, которые можно двигать, обязана остаться объёмной и
 * невывернутой.
 *
 * Совпадение вершин - это вырожденная фигура: ребро схлопнулось в точку, и ни
 * хорда, ни сечение по ней не считаются.
 *
 * Вогнутость ловится пересечением рёбер. Проверка «каждая вершина в
 * полупространстве каждой грани» строже и не годится: она требует, чтобы грань
 * осталась плоской, а сдвиг угла наклоняет грань даже у честного параллелепипеда,
 * и отказ пришёлся бы на самый ход, ради которого всё затевалось.
 *
 * Проверка идёт по рёбрам, а не по граням, и в этом суть. Пересекаются именно
 * рёбра одной грани, когда грань становится невыпуклой: у четырёхугольника
 * стороны AB и CD общих вершин не имеют, и при загибе они пересекаются. Проверка
 * граней этот случай пропускала бы: у каждого из этих рёбер своя грань в списке,
 * а грани, которой они не принадлежат, та сторона пересечения не касается.
 *
 * Знак пирамиды от центра фигуры, казалось бы, годится тем же, но он мёртвый:
 * `buildSolid` доворачивает обход грани наружу от центра всегда, поэтому знак
 * положителен у любой собранной фигуры и ничего не сообщает.
 *
 * Рёбер у параллелепипеда двенадцать, пар без общей вершины около сорока, и
 * проверка годится для каждого кадра перетаскивания.
 *
 * Второй признак - пересечение вееров граней. Сдвиг угла делает грани
 * некомпланарными, и веер из двух треугольников может сложиться в бабочку:
 * плоскость сечения режет такую грань вчетверо, и у куба с шестью гранями сечение
 * даёт семь-девять вершин. Рёбра при этом могут и не пересекаться, поэтому
 * проверка рёбер сама по себе сгиб пропускает.
 */
function solidFault(s: Solid): SolidFault | null {
  for (let i = 0; i < s.vertices.length; i++) {
    for (let j = i + 1; j < s.vertices.length; j++) {
      if (dist(s.vertices[i], s.vertices[j]) < 1e-3) return 'coincident';
    }
  }
  if (edgesCrossed(s.vertices, s.edges) || fansCrossed(s)) return 'inverted';
  return solidVolume(s) > VOLUME_EPS ? null : 'collapsed';
}

/** Есть ли среди рёбер пересекающиеся, не имея общих концов. */
function edgesCrossed(vertices: Vec3[], edges: [number, number][]): boolean {
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (segmentsHit(vertices[a], vertices[b], vertices[c], vertices[d])) return true;
    }
  }
  return false;
}

/**
 * Складывается ли веер какой-нибудь грани в бабочку.
 *
 * Поверхность фигуры - это ровно те треугольники, которые строит `buildSolid` и
 * рисует `Viewer`: грань веером от первой вершины. Проверяются они попарно, и
 * треугольники с общей вершиной смежны и пересекаться не могут.
 */
function fansCrossed(s: Solid): boolean {
  const tris: Vec3[][] = [];
  for (const f of s.faces) {
    for (let k = 1; k + 1 < f.poly.length; k++) {
      tris.push([s.vertices[f.poly[0]], s.vertices[f.poly[k]], s.vertices[f.poly[k + 1]]]);
    }
  }
  for (let i = 0; i < tris.length; i++) {
    for (let j = i + 1; j < tris.length; j++) {
      if (sharesVertex(tris[i], tris[j])) continue;
      if (trianglesHit(tris[i], tris[j])) return true;
    }
  }
  return false;
}

/** Есть ли у двух треугольников общая вершина: такие смежны и не пересекаются. */
const sharesVertex = (a: Vec3[], b: Vec3[]): boolean =>
  a.some((p) => b.some((q) => eq(p, q, 1e-9)));

function trianglesHit(t1: Vec3[], t2: Vec3[]): boolean {
  for (const [p, q] of [
    [t1[0], t1[1]],
    [t1[1], t1[2]],
    [t1[2], t1[0]],
  ]) {
    if (segmentHitsTriangle(p, q, t2[0], t2[1], t2[2])) return true;
  }
  for (const [p, q] of [
    [t2[0], t2[1]],
    [t2[1], t2[2]],
    [t2[2], t2[0]],
  ]) {
    if (segmentHitsTriangle(p, q, t1[0], t1[1], t1[2])) return true;
  }
  return false;
}

/**
 * Пересекает ли отрезок треугольник.
 *
 * Точка пересечения ищется по знакам расстояний до плоскости грани, и лишь потом
 * проверяется, что она внутри треугольника. Обратный порядок не годится: точка
 * на продолжении грани прошла бы как внутри неё.
 */
function segmentHitsTriangle(p: Vec3, q: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const n = cross(sub(b, a), sub(c, a));
  const d1 = dot(n, sub(p, a));
  const d2 = dot(n, sub(q, a));
  if (d1 * d2 > 0) return false;
  if (Math.abs(d1) < 1e-12) return Math.abs(d2) > 1e-12 && pointInTriangle(p, n, a, b, c);
  const t = d1 / (d1 - d2);
  return pointInTriangle(lerp(p, q, t), n, a, b, c);
}

/**
 * Внутри ли точка треугольника. Знаки берутся у векторных произведений, ведущих
 * по его сторонам: у точки снаружи хотя бы одно смотрит в другую сторону от
 * нормали.
 */
function pointInTriangle(m: Vec3, n: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  return (
    dot(cross(sub(b, a), sub(m, a)), n) >= 0 &&
    dot(cross(sub(c, b), sub(m, b)), n) >= 0 &&
    dot(cross(sub(a, c), sub(m, c)), n) >= 0
  );
}

/**
 * Пересекаются ли отрезки в пространстве.
 *
 * Отрезки различны по направлению, иначе они лежат на одной прямой: параллельные
 * рёбра одной грани не пересекаются никогда, а коллинеарных рёбер у фигуры нет.
 *
 * Считаются параметры пересечения `t` и `s`: точка пересечения есть, если оба
 * лежат внутри своих отрезков. Параметры осмыслены только у компланарных отрезков,
 * поэтому комплалярность проверяется первой.
 *
 * Одних знаков «по разные стороны от плоскости» мало, и это была настоящая ошибка:
 * у компланарных отрезков, какими являются соседние стороны одной грани, знаки
 * нулевые у обоих концов, и такой признак считал их пересекающимися при любых
 * вершинах. На исходном кубе так отвергался любой сдвиг угла, то есть ровно то,
 * ради чего всё затевалось.
 */
function segmentsHit(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): boolean {
  const u = sub(p2, p1);
  const w = sub(p4, p3);
  const n = cross(u, w);
  const nn = dot(n, n);
  if (nn < 1e-18) return false;
  // Компланарность. Дальше считаются параметры пересечения, а они имеют смысл
  // только у отрезков в одной плоскости.
  if (Math.abs(dot(n, sub(p3, p1))) > 1e-9) return false;
  // Параметр t на первом отрезке, s на втором. Пересечение есть, если оба лежат
  // внутри своих отрезков.
  const t = dot(cross(sub(p3, p1), w), n) / nn;
  const s = dot(cross(sub(p1, p3), u), n) / nn;
  return t >= -1e-9 && t <= 1 + 1e-9 && s >= -1e-9 && s <= 1 + 1e-9;
}

/** Центр фигуры: среднее по вершинам. Им же решается, куда смотрят нормали. */
function centerOf(vertices: Vec3[]): Vec3 {
  return mul(vertices.reduce((s, p) => add(s, p), v3(0, 0, 0)), 1 / vertices.length);
}

/**
 * Объём выпуклого многогранника через сумму тетраэдров от начала координат.
 *
 * Считается по граням, а не по разности углов: у невывернутой фигуры знак
 * объёма положителен, и ноль означает, что фигура схлопнулась в плоскость.
 */
function solidVolume(s: Solid): number {
  let v = 0;
  for (const f of s.faces) {
    const a = s.vertices[f.poly[0]];
    for (let k = 1; k + 1 < f.poly.length; k++) {
      v += dot(a, cross(s.vertices[f.poly[k]], s.vertices[f.poly[k + 1]])) / 6;
    }
  }
  return v;
}

/** Ниже этого объёма фигура считается плоской: углы сдвинули почти в одну плоскость. */
const VOLUME_EPS = 1e-4;

/**
 * Раскладка вершин параллелепипеда. Индекс кодирует, какие из трёх рёбер уже
 * добавлены к A, поэтому он не совпадает с порядком букв: 0 = A, 1 = D,
 * 2 = A₁, 3 = D₁, 4 = B, 5 = C, 6 = B₁, 7 = C₁.
 */
const BOX_FACES: number[][] = [
  [0, 4, 5, 1], // ABCD
  [2, 6, 7, 3], // A₁B₁C₁D₁
  [0, 4, 6, 2], // ABB₁A₁
  [4, 5, 7, 6], // BCC₁B₁
  [1, 0, 2, 3], // DAA₁D₁
  [5, 1, 3, 7], // CDD₁C₁
];

const BOX_LETTERS = ['A', 'D', 'A₁', 'D₁', 'B', 'C', 'B₁', 'C₁'];

/**
 * Параллелепипед из трёх рёбер, выходящих из A. Куб и прямоугольный
 * параллелепипед - частные случаи, отличаются только рёбрами, поэтому правила
 * сечения у них общие по построению, а не по совпадению.
 *
 * Грани называются по своей плоскости (`x = +1.4`) или буквами вершин
 * (`ABB₁A₁`). Различие не в том, как грань выглядит, а в том, переживёт ли её
 * подпись сдвиг угла: у грани, параллельной оси, расстояние берётся заново, у
 * грани под углом буквы остаются теми же.
 */
function parallelepiped(
  id: SolidId,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  w: Vec3,
  byPlane: boolean
): Solid {
  const vertices: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    let p = clone(origin);
    if (i & 4) p = add(p, u);
    if (i & 2) p = add(p, v);
    if (i & 1) p = add(p, w);
    vertices.push(p);
  }
  return buildSolid(
    id,
    vertices,
    BOX_FACES.map((poly) => ({
      poly,
      byPlane,
      // Буквы есть и у граней, называемых по плоскости: сдвинутый угол может
      // свести грань с оси, и тогда назвать её буквами лучше, чем не назвать
      // вовсе.
      letters: poly.map((i) => BOX_LETTERS[i]).join(''),
    })),
    BOX_LETTERS.map((name, index) => ({ name, index }))
  )!;
}

/** Правильный тетраэдр, вписанный в куб: рёбра те же, что у куба. */
const TETRA_L = 1 / Math.SQRT2;

const TETRA_CORNERS: { name: string; p: Vec3 }[] = [
  { name: 'A', p: v3(TETRA_L, TETRA_L, TETRA_L) },
  { name: 'B', p: v3(TETRA_L, -TETRA_L, -TETRA_L) },
  { name: 'C', p: v3(-TETRA_L, TETRA_L, -TETRA_L) },
  { name: 'D', p: v3(-TETRA_L, -TETRA_L, TETRA_L) },
];

export const SOLIDS: Record<SolidId, Solid> = {
  cube: parallelepiped('cube', v3(-1, -1, -1), v3(2, 0, 0), v3(0, 2, 0), v3(0, 0, 2), true),
  box: parallelepiped('box', v3(-1, -0.6, -1.2), v3(2, 0, 0), v3(0, 1.2, 0), v3(0, 0, 2.4), true),
  // Наклонный параллелепипед проверяет, что правила не завязаны на грани,
  // параллельные осям: его боковые грани стоят под углом ко всем трём.
  slant: parallelepiped(
    'slant',
    v3(-1, -0.7, -1.1),
    v3(2, 0, 0),
    v3(0.6, 1.4, 0),
    v3(0, 0, 2.2),
    false
  ),
  tetra: buildSolid(
    'tetra',
    TETRA_CORNERS.map((c) => c.p),
    [
      { poly: [0, 1, 2], letters: 'ABC' },
      { poly: [0, 1, 3], letters: 'ABD' },
      { poly: [0, 2, 3], letters: 'ACD' },
      { poly: [1, 2, 3], letters: 'BCD' },
    ],
    TETRA_CORNERS.map((c, index) => ({ name: c.name, index }))
  )!,
};

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
 * по хорде фигуры: иначе она обрывается там, где до края экрана ещё далеко,
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
 * Все грани фигуры, на которых лежит точка. Точка на ребре принадлежит двум
 * граням, вершина - трём и более, поэтому одиночного индекса для проверки
 * соседей не хватает: цепочку сечения можно вести через ребро, и обе грани на
 * счётчике.
 *
 * Проверяется вся фигура, как в `faceOf`: точка в плоскости грани, но за её
 * краем, ни на какой грани не лежит, иначе цепочка приняла бы её соседом.
 */
export function pointFaces(solid: Solid, p: Vec3, eps = 1e-4): number[] {
  if (!insideSolid(solid, p, eps)) return [];
  const out: number[] = [];
  for (let i = 0; i < solid.faces.length; i++) {
    const f = solid.faces[i];
    if (Math.abs(dot(f.normal, p) - f.d) < eps) out.push(i);
  }
  return out;
}

/**
 * Грань фигуры, на которой лежит точка, или `null` вне граней.
 *
 * Проверяется вся фигура, а не одна плоскость грани: точка на прямой, ушедшей
 * за пределы фигуры, лежит в плоскости грани и за её краем, и такая подсветка
 * вводила бы в заблуждение - точка стоит в стороне, а горит не та грань.
 *
 * Индекс приводится к `null` прямо здесь, на границе модуля: `faces[-1].normal`
 * уронил бы обработчик превью вместе со всей отрисовкой.
 */
export function faceOf(solid: Solid, p: Vec3, eps = 1e-4): number | null {
  if (!insideSolid(solid, p, eps)) return null;
  for (let i = 0; i < solid.faces.length; i++) {
    const f = solid.faces[i];
    if (Math.abs(dot(f.normal, p) - f.d) < eps) return i;
  }
  return null;
}

/**
 * Насколько грань отстоит от своей плоскости собственными вершинами.
 *
 * Сдвинутый угол делает грань некомпланарной, а плоскость у неё одна на всех:
 * `buildSolid` берёт её по трём вершинам из четырёх, и оставшаяся из плоскости
 * выходит. Точка на нарисованной грани оказывается по другую сторону этой
 * плоскости, и проверка «внутри ли фигура» отвергала её - сечение через такую
 * точку построить было нельзя. Поэтому каждой грани разрешается отклонение,
 * равное её собственному разбросу вершин.
 *
 * У куба, параллелепипеда и тетраэдра разброс нулевой, и проверка остаётся
 * прежней: точка на продолжении грани за пределами фигуры по-прежнему отвергается.
 */
function faceSlack(solid: Solid, f: SolidFace): number {
  let out = 0;
  for (const i of f.poly) {
    out = Math.max(out, Math.abs(dot(f.normal, solid.vertices[i]) - f.d));
  }
  return out;
}

/**
 * Внутри ли точка фигуры, включая грани, рёбра и вершины.
 *
 * Проверяются все грани, а не координаты по модулю: у наклонного
 * параллелепипеда и тетраэдра грани стоят под углом к осям, и половина
 * «минус один» для них ничего не значит.
 */
export function insideSolid(solid: Solid, p: Vec3, eps = 1e-4): boolean {
  return solid.faces.every((f) => dot(f.normal, p) - f.d <= faceSlack(solid, f) + eps);
}

/**
 * Ближайшая точка грани: сначала ортогональная проекция на её плоскость,
 * затем прижимание внутрь многоугольника.
 *
 * Прижимание идёт по сторонам грани, а не по координатам: у тетраэдра грань -
 * треугольник, и зажим по осям уводил бы точку за его пределы. Стороны
 * полупространствами, поэтому несколько проходов сходятся к грани целиком.
 */
export function projectToFace(solid: Solid, p: Vec3, faceIndex: number): Vec3 {
  const f = solid.faces[faceIndex];
  let q = sub(p, mul(f.normal, dot(f.normal, p) - f.d));
  for (let pass = 0; pass < f.poly.length; pass++) {
    let moved = false;
    for (let i = 0; i < f.poly.length; i++) {
      const a = solid.vertices[f.poly[i]];
      const b = solid.vertices[f.poly[(i + 1) % f.poly.length]];
      // Внутренняя нормаль стороны лежит в плоскости грани: наружу от неё
      // уходит только сама грань, поэтому знак берётся из обхода вершин.
      const inward = norm(cross(f.normal, sub(b, a)));
      if (!inward) continue;
      const out = dot(inward, sub(q, a));
      if (out >= 0) continue;
      q = sub(q, mul(inward, out));
      moved = true;
    }
    if (!moved) break;
  }
  return q;
}

export type SnapKind = 'none' | 'edge' | 'vertex';

/**
 * Шаг сетки притяжения: столько же, сколько делений у сетки на полу. Привязка
 * невидима, если её шаг не совпадает с нарисованной сеткой, и выглядит так,
 * будто точки прыгают сами.
 */
export const GRID_STEP = 0.2;
/** Ближайший узел сетки по каждой координате. */
export function snapToGrid(p: Vec3, step = GRID_STEP): Vec3 {
  const near = (n: number) => Math.round(n / step) * step;
  return v3(near(p.x), near(p.y), near(p.z));
}

/**
 * Узел сетки на грани фигуры.
 *
 * Привязываются только координаты вдоль грани, а та, что лежит по её нормали,
 * выводится из плоскости. Иначе сдвиг по сетке увёл бы точку с грани, а у
 * наклонной грани тетраэдра или наклонного параллелепипеда она вообще ушла бы
 * внутрь фигуры, и дальше по точке нечего было бы построить.
 *
 * Узел сетки общий для всей фигуры, а грань - её часть, поэтому узел может
 * выпасть за многоугольник грани. Такую точку обязательно прижимаем внутрь, как
 * это делает `snapFacePoint` при свободном сдвиге: точка вне граней не
 * принадлежит ни одной из них, и цепочку сечения через неё вести нельзя.
 */
export function snapToGridOnFace(
  solid: Solid,
  p: Vec3,
  faceIndex: number,
  step = GRID_STEP
): Vec3 {
  const f = solid.faces[faceIndex];
  const n = [f.normal.x, f.normal.y, f.normal.z];
  const abs = n.map(Math.abs);
  // Ось по нормали - та, где модуль компоненты наибольший: нулевой у грани не
  // бывает, иначе грань выродилась бы в прямую.
  const k = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
  const q = snapToGrid(p, step);
  const at = [q.x, q.y, q.z];
  const rest = n[0] * at[0] + n[1] * at[1] + n[2] * at[2] - n[k] * at[k];
  at[k] = (f.d - rest) / n[k];
  return projectToFace(solid, v3(at[0], at[1], at[2]), faceIndex);
}

export function snapToSolid(
  solid: Solid,
  p: Vec3,
  threshold = 0.14
): { p: Vec3; kind: SnapKind } {
  let best: Vec3 | null = null;
  let bestD = threshold;
  for (const vertex of solid.vertices) {
    const d = dist(p, vertex);
    if (d < bestD) {
      bestD = d;
      best = vertex;
    }
  }
  if (best) return { p: clone(best), kind: 'vertex' };

  for (const [i, j] of solid.edges) {
    const a = solid.vertices[i];
    const b = solid.vertices[j];
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
 * Добавляет точку, если рядом такой же точки ещё нет. Одна вершина фигуры
 * лежит сразу на нескольких рёбрах, поэтому без проверки сечение насчитало бы
 * лишние вершины.
 */
function pushUnique(out: Vec3[], p: Vec3): void {
  if (!out.some((q) => eq(p, q, 1e-5))) out.push(p);
}

export function planeEdgePoints(solid: Solid, pl: Plane): Vec3[] {
  const found: Vec3[] = [];
  for (const [i, j] of solid.edges) {
    const a = solid.vertices[i];
    const b = solid.vertices[j];
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

export function sectionPolygon(solid: Solid, pl: Plane): Vec3[] {
  const pts = planeEdgePoints(solid, pl);
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
 * ребру фигуры - без него точка на прямой у края не находила бы общую грань и
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
 * хорда фигуры, если прямая через него проходит. За этими границами начинаются
 * хвосты, и только они отсекаются.
 */
function untrimmable(solid: Solid, l: Line3, b: Vec3): [number, number] {
  const t = (p: Vec3) => dot(sub(p, l.p), l.dir);
  // Точка `b` не обязана лежать на параметре 1: параметр вдоль прямой измерен в
  // единицах длины, поэтому конец - это |b − a|. Считать его единицей нельзя,
  // иначе ядро перестаёт содержать `b` и отсечение отрезает её от прямой.
  let lo = 0;
  let hi = t(b);
  const hits = lineEdgeHits(solid, l);
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
export function trimmedSpan(
  solid: Solid,
  base: [Vec3, Vec3],
  cut?: Cut
): [Vec3, Vec3] {
  if (!cut?.trim) return base;
  const l = lineFromPoints(cut.a, cut.b);
  if (!l) return base;
  const t = (p: Vec3) => dot(sub(p, l.p), l.dir);
  const [lo, hi] = untrimmable(solid, l, cut.b);
  const start = cut.trim.start ? Math.min(lo, t(cut.trim.start)) : Math.min(lo, t(base[0]));
  const end = cut.trim.end ? Math.max(hi, t(cut.trim.end)) : Math.max(hi, t(base[1]));
  return [add(l.p, mul(l.dir, start)), add(l.p, mul(l.dir, end))];
}

/**
 * С какой стороны прямой лежит точка: за началом, перед концом или между ними.
 * Определяет, какое из двух отсечений ей соответствует.
 */
export function trimEndOf(
  solid: Solid,
  a: Vec3,
  b: Vec3,
  p: Vec3
): TrimEnd | 'inside' {
  const l = lineFromPoints(a, b);
  if (!l) return 'inside';
  const t = dot(sub(p, l.p), l.dir);
  const [lo, hi] = untrimmable(solid, l, b);
  if (t <= lo) return 'start';
  if (t >= hi) return 'end';
  return 'inside';
}

/** Расстояние от точки до отрезка: то же, что `pointOnSegment`, но числом. */
export function distPointSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const u = sub(b, a);
  const uu = dot(u, u);
  if (uu < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), u) / uu));
  return dist(p, add(a, mul(u, t)));
}

export function pointOnSegment(p: Vec3, a: Vec3, b: Vec3, eps = 1e-6): boolean {
  const u = sub(b, a);
  const uu = dot(u, u);
  if (uu < 1e-12) return dist(p, a) < eps;
  const s = dot(sub(p, a), u) / uu;
  if (s < -eps || s > 1 + eps) return false;
  return dist(p, add(a, mul(u, s))) < eps;
}

export function lineEdgeHits(solid: Solid, l: Line3): Vec3[] {
  const out: Vec3[] = [];
  for (const [i, j] of solid.edges) {
    const p = lineSegmentHit(l, solid.vertices[i], solid.vertices[j]);
    if (p) pushUnique(out, p);
  }
  return out;
}
