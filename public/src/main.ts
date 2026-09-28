import * as THREE from 'three';
import {
  dist,
  eq,
  faceOf,
  fmt,
  insideSolid,
  lineFromPoints,
  lineEdgeHits,
  lineIntersect,
  norm,
  planeEdgePoints,
  planeFromPoints,
  planeSigned,
  pointFaces,
  pointOnSegment,
  projectToFace,
  sectionPolygon,
  snapToSolid,
  trimEndOf,
  trimmedSpan,
  v3,
  type Line3,
  type Plane,
  type SolidId,
  type TrimEnd,
  type Vec3,
} from './geometry';
import {
  Store,
  addCorners,
  makeLine,
  makePlane,
  makePoint,
  makeSegment,
  nextPointName,
  type LineObj,
  type PointObj,
  type SceneObj,
  type SegmentObj,
  type Tool,
} from './model';
import { COLOR } from './colors';
import {
  DEMO,
  SOLIDS_UI,
  TOOLS_UI,
  noTargetHint,
  solidGen,
  trimDone,
  trimHint,
} from './hints';
import { HELP_TOOLS, HELP_VIEW } from './help';
import { ICON_CROSS, ICON_EYE, SOLID_ICONS, TOOL_ICONS } from './icons';
import { buildScene, fatLine, toV } from './objects3d';
import { Viewer } from './viewer';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const MAGNET_RADIUS = 0.16;
const CROSS_RADIUS = 0.12;
// При выключенном притяжении магнит пропадает, но «Прямая» и «Плоскость» без
// него не работают вовсе: остаётся требование попасть в саму точку, а не рядом.
const PICK_RADIUS = 0.06;
// Допуск проверки принадлежности плоскости. Точки прилипают к рёбрам и вершинам,
// поэтому координаты копятся с точностью магнита, а не машины.
const PLANE_EPS = 1e-3;

// Нормаль демо-среза своя у каждой фигуры: у куба, параллелепипеда и его
// наклонного варианта x + y + z = 0 даёт шестиугольник через середины шести
// рёбер, а у тетраэдра та же плоскость прошла бы всего по двум рёбрам и
// сечения не дала. Точки демо берутся из той же геометрии, что и любой чертёж,
// поэтому демо не может разойтись с правилами инструмента.
const DEMO_NORMAL: Record<SolidId, Vec3> = {
  cube: v3(1, 1, 1),
  tetra: v3(1, 0, 0),
  box: v3(1, 1, 1),
  slant: v3(1, 1, 1),
};

const canvas = $<HTMLCanvasElement>('#view');
const store = new Store();
const viewer = new Viewer(canvas);

/** Точка ввода: координаты плюс имя, чтобы ошибки называли конкретные точки. */
type PendingPoint = { p: Vec3; name: string };

type ToolState = {
  tool: Tool;
  pending: PendingPoint[];
  snapEnabled: boolean;
  chainEnabled: boolean;
  stickRadius: number;
  drag: null | { id: string; part: string; moved: boolean };
  hoverInfo: string;
};

const state: ToolState = {
  tool: 'select',
  pending: [],
  snapEnabled: true,
  chainEnabled: true,
  stickRadius: 0.25,
  drag: null,
  hoverInfo: '',
};

/**
 * Единственный источник положения точки: и превью, и сам клик идут через
 * `resolveTarget`, поэтому подсветка не может разойтись с результатом.
 *
 * Порядок притяжения у «Точки»: стоящая точка, узел двух прямых, прямая, грань.
 * У «Прямой», «Отрезка» и «Плоскости» цель одна - уже стоящая точка, поэтому
 * построение по ним не может добавить в сцену новую точку.
 *
 * Кнопка «Притягивание» гасит все магниты разом: остаётся грань для «Точки» и
 * точное попадание в маркер точки для остальных инструментов.
 */
type Target = {
  p: Vec3;
  name: string;
  faceIndex: number | null;
  magnet: 'point' | 'line' | 'cross' | 'face' | null;
  label: string;
};

/** Отрезок, прямая и плоскость строятся только по точкам, уже стоящим в сцене. */
function isPointOnlyTool(tool: Tool): boolean {
  return tool === 'line' || tool === 'segment' || tool === 'plane';
}

/**
 * Точка, по которой отсекают, и сторона прямой, с которой снимается хвост.
 *
 * У отсечения своя цель, а не точка из `resolveTarget`: здесь «точка» - это
 * место разреза, а не объект, который ставится в сцену, поэтому цель описана
 * отдельно и не проходит через магниты построения.
 */
type TrimTarget = {
  obj: LineObj;
  point: PointObj;
  end: TrimEnd;
};

/**
 * Тот ли разрез стоит на этой точке. Допуск тот же, что у магнита: иначе клик по
 * той же точке то возвращал бы хвост, то ставил бы второй разрез рядом с ним.
 */
function sameCutPoint(cut: Vec3, p: Vec3): boolean {
  return dist(cut, p) < MAGNET_RADIUS;
}

/**
 * Отрезок, по которому объект реально нарисован: у прямой это часть кадра, у
 * отсечённой - обрезанный отрезок, у отрезка - свои концы.
 *
 * Рисунок, прилипание и отсечение обязаны брать один и тот же отрезок,
 * иначе курсор будет тянуться туда, где объекта уже нет.
 */
function drawnSpan(obj: LineObj | SegmentObj): [Vec3, Vec3] | null {
  if (obj.kind === 'segment') return [obj.a, obj.b];
  const l = lineFromPoints(obj.a, obj.b);
  if (!l) return null;
  const base = viewer.lineExtent(l);
  return base ? trimmedSpan(store.solid, base, { a: obj.a, b: obj.b, trim: obj.trim }) : null;
}

/**
 * Отсечение бьёт только по уже стоящей точке, лежащей на прямой. Резать в
 * произвольном месте нельзя: разрез должен совпадать с объектом сцены,
 * иначе его нельзя ни отменить, ни показать в списке объектов.
 *
 * Точка за пределами хорды фигуры задаёт сторону: хвост снимается с той стороны,
 * где она лежит. Точки внутри хорды целью не годятся - хвоста с их стороны нет.
 *
 * Сторона, по которой уже отрезали, закрыта: целью на ней остаётся сама точка
 * отсечения, и клик по ней хвост возвращает. Другие точки этой стороны целями
 * не годятся, иначе разрез можно было бы передвинуть на точку, для которой он
 * ничего не значит, а автообрезка, закрывшая сторону, перестала бы что-то
 * запрещать. Признак «та же точка» один на цель и на действие, иначе подсказка
 * обещала бы вернуть хвост, а клик двигал бы разрез.
 *
 * Через точку проходит сколько угодно прямых - узел, общая точка построения, -
 * и клик режет их все: иначе у второй прямой остался бы хвост, который человек
 * счёл срезанным. Поэтому цель здесь список, а не единственная пара «прямая,
 * сторона». Точка сначала выбирается одна, ближайшая к курсору, и уже потом
 * собираются все прямые через неё: иначе под курсором нашлись бы две точки
 * вплотную и отсечение било бы то по одной, то по другой.
 */
function resolveTrimTargets(): TrimTarget[] {
  let best: { point: PointObj; d: number } | null = null;
  for (const point of store.doc.objects) {
    if (point.kind !== 'point' || !point.visible) continue;
    const d = viewer.rayToPointDistance(point.p.x, point.p.y, point.p.z);
    // Побеждает ближайшая к курсору точка, а не первая найденная: под курсором
    // их может оказаться несколько, и резать надо ту, что ближе.
    if (d < MAGNET_RADIUS && (!best || d < best.d)) best = { point, d };
  }
  if (!best) return [];

  const targets: TrimTarget[] = [];
  for (const obj of store.doc.objects) {
    if (!obj.visible || obj.kind !== 'line') continue;
    const seg = drawnSpan(obj);
    if (!seg) continue;
    if (!pointOnSegment(best.point.p, seg[0], seg[1], 1e-3)) continue;
    const end = trimEndOf(store.solid, obj.a, obj.b, best.point.p);
    if (end === 'inside') continue;
    const cut = obj.trim?.[end];
    if (cut && !sameCutPoint(cut, best.point.p)) continue;
    targets.push({ obj, point: best.point, end });
  }
  return targets;
}

function resolveTarget(): Target | null {
  const pointOnly = isPointOnlyTool(state.tool);
  // «Прямая», «Отрезок» и «Плоскость» берут точки всегда: с выключенным
  // притягиванием остаётся лишь требование попасть в сам маркер точки. У «Точки»
  // магнита к точкам без притягивания нет вовсе, как и к рёбрам, вершинам,
  // пересечениям и прямым: точка встаёт ровно под курсор.
  let pointRadius = 0;
  if (state.snapEnabled) pointRadius = MAGNET_RADIUS;
  else if (pointOnly) pointRadius = PICK_RADIUS;

  // Магниты к пересечениям и самим прямым есть только у «Точки». У «Прямой»
  // они запрещены намеренно: новая прямая прилипла бы к старой и схлопнулась
  // в точку.
  const attract = state.snapEnabled && state.tool === 'point';

  // Прямая идёт до краёв кадра, отрезок - только между своими концами. Разница
  // не в рисунке, а в узлах: пересечение считается внутри этих границ, иначе
  // отрезок дал бы точку там, где его нет.
  const lines: { l: Line3; a: Vec3; b: Vec3 }[] = [];
  let bestPoint: { p: Vec3; face: number | null; name: string; d: number } | null = null;
  let bestLine: { p: Vec3; name: string; d: number } | null = null;

  for (const obj of store.doc.objects) {
    if (!obj.visible) continue;

    if (obj.kind === 'point') {
      const d = viewer.rayToPointDistance(obj.p.x, obj.p.y, obj.p.z);
      if (d < pointRadius && (!bestPoint || d < bestPoint.d)) {
        bestPoint = { p: obj.p, face: obj.face, name: obj.name, d };
      }
      continue;
    }

    if ((obj.kind === 'line' || obj.kind === 'segment') && attract) {
      const l = lineFromPoints(obj.a, obj.b);
      if (!l) continue;
      const seg = drawnSpan(obj);
      if (!seg) continue;
      lines.push({ l, a: seg[0], b: seg[1] });
      const hit = viewer.rayToSegmentHit(seg[0], seg[1]);
      if (hit.d < MAGNET_RADIUS && (!bestLine || hit.d < bestLine.d)) {
        bestLine = { p: hit.p, name: obj.name, d: hit.d };
      }
    }
  }

  if (bestPoint) {
    return {
      p: bestPoint.p,
      name: bestPoint.name,
      faceIndex: bestPoint.face,
      magnet: 'point',
      label: pointOnly ? `выбрать точку ${bestPoint.name}` : `к точке ${bestPoint.name}`,
    };
  }
  if (pointOnly) return null;

  // Узел из пересечения двух прямых: он предпочтительнее любой точки
  // вскользь на прямой, поэтому ищется отдельно и имеет свой радиус.
  let bestCross: { p: Vec3; d: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lineIntersect(lines[i].l, lines[j].l);
      if (!p) continue;
      // Отрезок не бесконечен, поэтому узел годен, только если он попадает
      // внутрь обоих: иначе точка встанет там, где отрезка нет.
      if (!pointOnSegment(p, lines[i].a, lines[i].b)) continue;
      if (!pointOnSegment(p, lines[j].a, lines[j].b)) continue;
      const d = viewer.rayToPointDistance(p.x, p.y, p.z);
      if (d < CROSS_RADIUS && (!bestCross || d < bestCross.d)) bestCross = { p, d };
    }
  }
  if (bestCross) {
    return {
      p: bestCross.p,
      name: '',
      faceIndex: faceOf(store.solid, bestCross.p),
      magnet: 'cross',
      label: 'в пересечении прямых',
    };
  }
  // Узел прямой с ребром фигуры. Он предпочтительнее любой точки на прямой:
  // иначе точка у края встаёт мимо ребра, не находит общей грани с соседней
  // точкой сечения и цепочка не замыкается. Радиус тот же, что у пересечения
  // двух прямых, - оба случая ищут одно и то же место.
  let bestEdge: { p: Vec3; d: number } | null = null;
  for (const { l, a, b } of lines) {
    for (const p of lineEdgeHits(store.solid, l)) {
      if (!pointOnSegment(p, a, b)) continue;
      const d = viewer.rayToPointDistance(p.x, p.y, p.z);
      if (d < CROSS_RADIUS && (!bestEdge || d < bestEdge.d)) bestEdge = { p, d };
    }
  }
  if (bestEdge) {
    return {
      p: bestEdge.p,
      name: '',
      faceIndex: faceOf(store.solid, bestEdge.p),
      magnet: 'cross',
      label: `на ребре ${solidGen(store.doc.solid)}`,
    };
  }
  if (bestLine) {
    return {
      p: bestLine.p,
      name: bestLine.name,
      faceIndex: faceOf(store.solid, bestLine.p),
      magnet: 'line',
      label: `на прямой ${bestLine.name}`,
    };
  }

  // Без притяжения грань принимается только под самим курсором: pickFaceSurface
  // с нулём оставляет себе технический допуск в 0.02 и не тянет точку за край.
  const picked = viewer.pickFaceSurface(state.snapEnabled ? state.stickRadius : 0);
  if (picked.type !== 'face') return null;
  return {
    p: snapFacePoint(picked.point, picked.faceIndex),
    name: '',
    faceIndex: picked.faceIndex,
    magnet: 'face',
    label: '',
  };
}

function previewKind(): 'point' | 'line' {
  return state.tool === 'point' ? 'point' : 'line';
}

function updateHover(): void {
  const info = $('#cursor-info');
  if (state.tool === 'trim') {
    updateTrimHover(info);
    return;
  }
  if (state.tool === 'select') {
    viewer.setPreview(null, null);
    viewer.setFaceHighlight(null);
    if (!state.hoverInfo) info.textContent = '';
    return;
  }
  const target = resolveTarget();
  if (!target) {
    viewer.setPreview(null, null);
    viewer.setFaceHighlight(null);
    info.textContent = '';
    return;
  }
  viewer.setPreview(target.p, target.faceIndex, previewKind());
  viewer.setFaceHighlight(target.faceIndex);

  if (target.magnet !== 'face') {
    state.hoverInfo = `${fmt(target.p)} · ${target.label}`;
  } else {
    const snapped = snapToSolid(store.solid, target.p);
    const kind =
      snapped.kind === 'none' ? 'свободно' : snapped.kind === 'edge' ? 'ребро' : 'вершина';
    const stuck = dist(snapped.p, target.p) > 1e-6 ? ' · прилипание' : '';
    state.hoverInfo = `${faceName(target.faceIndex as number)} · ${fmt(target.p)} · ${kind}${stuck}`;
  }
  info.textContent = state.hoverInfo;
}

/** Превью отсечения: маркер стоит на точке разреза, грань тут ни при чём. */
function updateTrimHover(info: HTMLElement): void {
  const targets = resolveTrimTargets();
  if (!targets.length) {
    viewer.setPreview(null, null);
    viewer.setFaceHighlight(null);
    info.textContent = '';
    return;
  }
  viewer.setPreview(targets[0].point.p, null, 'line');
  viewer.setFaceHighlight(null);
  const { point, side, back } = trimIntent(targets);
  state.hoverInfo = trimHint(
    fmt(point.p),
    targets.map((t) => t.obj.name),
    side,
    back
  );
  info.textContent = state.hoverInfo;
}

/**
 * Что сделает клик по этой точке: снимет хвост или вернёт его, и с какой стороны.
 *
 * Действие одно на все прямые точки, а не у каждой своё. Иначе под курсором
 * оказалась бы прямая, по которой клик вернёт хвост, и прямая, по которой он же
 * этот хвост снова срежет, и что произойдёт, осталось бы неясным.
 *
 * Сторона тоже одна на все прямые: у разных прямых точки она разная, и назвать
 * первую попавшуюся значило бы соврать про остальные. Тогда она пустая, и
 * подсказка молчит о стороне вместо того, чтобы называть неверную.
 *
 * Признак общий на цель и на действие, иначе подсказка обещала бы вернуть хвост,
 * а клик двигал бы разрез.
 */
function trimIntent(targets: TrimTarget[]): {
  point: PointObj;
  side: string;
  back: boolean;
} {
  const point = targets[0].point;
  const back = targets.every((t) => {
    const cut = t.obj.trim?.[t.end];
    return cut !== undefined && sameCutPoint(cut, point.p);
  });
  const same = targets.every((t) => t.end === targets[0].end);
  const side = same ? (targets[0].end === 'start' ? 'с начала' : 'с конца') : '';
  return { point, side, back };
}

/**
 * Отсечение сразу по всем прямым, что проходят через точку. Возврат хвоста
 * ведёт себя так же: повторный клик по той же точке снимает разрез со всех
 * прямых разом.
 *
 * Всё меняется одним `commit`: правка каждой прямой отдельным `update` дала бы
 * на один клик несколько шагов отмены, и вернувшийся по Ctrl+Z чертёж разошёлся
 * бы с тем, что обещала подсказка.
 */
function applyTrim(targets: TrimTarget[]): void {
  if (!targets.length) return;
  const { point, back } = trimIntent(targets);
  const p = point.p;
  store.commit((d) => {
    for (const t of targets) {
      const obj = d.objects.find((o) => o.id === t.obj.id);
      if (obj?.kind !== 'line') continue;
      if (back) clearTrimEnd(obj, t.end);
      else obj.trim = { ...obj.trim, [t.end]: { ...p } };
    }
  });
  flash(trimDone(targets.map((t) => t.obj.name), back));
}

/**
 * Автоотсечение в узле: снимает хвост со стороны, где образовался узел.
 *
 * Сторона режется автоматически не больше одного раза: иначе каждая новая прямая,
 * пересёкшая старую снаружи фигуры, обрезала бы ей тот же хвост заново. Ручная
 * отсечка тоже закрывает сторону - пользователь решил, как она должна выглядеть.
 *
 * Узел внутри фигуры не режется: перпендикулярные прямые в одной грани - обычное
 * дело, и их пересечение обрезать не нужно. Проверяется именно фигура, а не плоскость
 * грани: узел на прямой, идущей по ребру, лежит в плоскости грани и за её краем.
 */
function autoTrimSide(obj: LineObj, at: Vec3, inside: boolean): TrimEnd | null {
  if (inside) return null;
  const end = trimEndOf(store.solid, obj.a, obj.b, at);
  if (end === 'inside' || obj.trim?.[end]) return null;
  return end;
}

/**
 * Пересечение двух прямых: ставит точку в узле и отсекает хвосты, для которых
 * автообрезка ещё не сработала. Точка появляется сама, иначе узел пришлось бы
 * дополнительно кликать, чтобы он стал объектом сцены.
 *
 * Всё меняется в одном `commit`: правка в обход него осталась бы в старой копии
 * документа, и следующий `commit` её затёр бы. Из-за того же цикла обхода
 * отрезки пересчитываются на каждый узел заново.
 */
function autoTrimAtCrossings(fresh: LineObj): void {
  const l1 = lineFromPoints(fresh.a, fresh.b);
  if (!l1) return;
  const seg1 = drawnSpan(fresh);
  if (!seg1) return;
  for (const obj of store.doc.objects) {
    if (!obj.visible || obj.kind !== 'line' || obj.id === fresh.id) continue;
    const l2 = lineFromPoints(obj.a, obj.b);
    if (!l2) continue;
    const seg2 = drawnSpan(obj);
    if (!seg2) continue;
    const p = lineIntersect(l1, l2);
    if (!p) continue;
    // Узел считается, только если он на нарисованных частях обеих прямых:
    // пересечение на отрезанном хвосте уже не то, что на экране.
    if (!pointOnSegment(p, seg1[0], seg1[1])) continue;
    if (!pointOnSegment(p, seg2[0], seg2[1])) continue;
    const at = { ...p };
    // Признак считается один раз на узел: режут обе прямые по одному правилу.
    const inside = insideSolid(store.solid, at);
    const end1 = autoTrimSide(fresh, at, inside);
    const end2 = autoTrimSide(obj, at, inside);
    store.commit((d) => {
      const here = d.objects.find((o) => o.id === fresh.id);
      if (here?.kind === 'line' && end1) here.trim = { ...here.trim, [end1]: at };
      const other = d.objects.find((o) => o.id === obj.id);
      if (other?.kind === 'line' && end2) other.trim = { ...other.trim, [end2]: at };
      if (!d.objects.some((o) => o.kind === 'point' && eq(o.p, p, 1e-4))) {
        d.objects.push(makePoint(d, p, faceOf(store.solid, p)));
      }
    });
    // Прямая в документе теперь обрезана, поэтому её отрезок пересчитывается по
    // новому состоянию: без этого следующая пара считалась бы по хвосту,
    // которого на экране уже нет. Trim на самих объектах цикла обновляется
    // тут же, иначе `for` продолжал бы считать по старому.
    if (end1) fresh.trim = { ...fresh.trim, [end1]: at };
    if (end2) obj.trim = { ...obj.trim, [end2]: at };
    const next = drawnSpan(fresh);
    if (!next) return;
    seg1[0] = next[0];
    seg1[1] = next[1];
    // Отсечение в узле не упоминаем: хвост снят сам, и отдельное сообщение об
    // этом только мешало видеть, что появилась точка.
    flash(`Узел прямых ${fresh.name} и ${obj.name}: точка поставлена`);
  }
}

const TOOL_NEEDS: Record<Tool, number> = {
  select: 0,
  point: 1,
  line: 2,
  segment: 2,
  plane: 3,
  // Отсечение работает одним кликом и само ничего не накапливает.
  trim: 0,
};

function snap(p: Vec3): Vec3 {
  return state.snapEnabled ? snapToSolid(store.solid, p).p : p;
}

function setTool(tool: Tool): void {
  state.tool = tool;
  state.pending = [];
  syncPending();
  updateToolbar();
  updateHover();
  refresh();
}

/**
 * Клик по цели. В режиме цепочки клики не собирают плошку, а наращивают
 * цепочку сечения, поэтому маршрут выбирается здесь, а не внутри `pushPending`.
 */
function onTargetClick(target: Target): void {
  if (state.tool === 'plane' && state.chainEnabled) {
    pushChain(target);
    return;
  }
  pushPending(target);
}

function pushPending(target: Target): void {
  state.pending.push({ p: target.p, name: target.name });
  syncPending();
  const need = TOOL_NEEDS[state.tool];
  if (need > 0 && state.pending.length >= need) {
    const batch = state.pending.slice(0, need);
    state.pending = state.pending.slice(need);
    syncPending();
    commitBatch(batch);
  }
  refresh();
}

/**
 * Наращивание цепочки сечения. Клик по первой точке замыкает цепочку, все
 * остальные клики добавляют точку, но только если она делит грань с
 * предыдущей: ребро сечения обязано целиком лежать в грани фигуры.
 */
function pushChain(target: Target): void {
  const chain = state.pending;
  const next: PendingPoint = { p: target.p, name: target.name };
  const first = chain[0];

  if (first && eq(first.p, next.p, 1e-4)) {
    closeChain();
    return;
  }
  if (chain.some((c) => eq(c.p, next.p, 1e-4))) {
    flash(`Точка ${next.name} уже стоит в цепочке`);
    return;
  }

  const problem = chain.length ? neighbourProblem(chain[chain.length - 1], next) : faceProblem(next);
  if (problem) {
    flash(problem);
    return;
  }

  chain.push(next);
  syncPending();
  refresh();
}

/** Точка вне граней фигуры в цепочку не годится: грань нужна для проверки соседей. */
function faceProblem(pt: PendingPoint): string | null {
  if (pointFaces(store.solid, pt.p).length) return null;
  return `Точка ${pt.name} вне граней ${solidGen(store.doc.solid)}, цепочку из неё не собрать`;
}

/**
 * Соседние точки сечения должны лежать на общей грани фигуры. Точка на ребре или
 * вершине принадлежит нескольким граням, поэтому проверяется пересечение
 * множеств, а не равенство одиночных индексов.
 */
function neighbourProblem(prev: PendingPoint, next: PendingPoint): string | null {
  const a = pointFaces(store.solid, prev.p);
  const b = pointFaces(store.solid, next.p);
  if (!a.length || !b.length) {
    const off = !a.length ? prev : next;
    return `Точка ${off.name} вне граней ${solidGen(store.doc.solid)}, цепочку через неё вести нельзя`;
  }
  if (a.some((f) => b.includes(f))) return null;
  return `У точек ${prev.name} и ${next.name} нет общей грани: ${prev.name} на ${faceList(a)}, а ${next.name} на ${faceList(b)}`;
}

function faceList(faces: number[]): string {
  return faces.map(faceName).join(' и ');
}

/**
 * Подпись грани фигуры: у куба это `x = +1`, у тетраэдра - `ABC`. Имя хранится
 * у фигуры, а не в общем списке, иначе у фигуры с треугольными гранями в
 * сообщении вылез бы чужой индекс.
 */
function faceName(index: number): string {
  return store.solid.faces[index]?.name ?? '';
}

/**
 * Замыкание цепочки. Плоскость строится по первым трём точкам, а остальные
 * проверяются на принадлежность ей: соседство по грани необходимое, но не
 * достаточное условие, и без этой проверки можно было бы замкнуть кривую,
 * которая плоскости не принадлежит.
 */
function closeChain(): void {
  const chain = state.pending;
  const names = chain.map((c) => c.name).join(' - ');

  if (chain.length < 3) {
    flash(`Для плоскости нужно минимум три точки, в цепочке ${chain.length}`);
    return;
  }
  const closing = neighbourProblem(chain[chain.length - 1], chain[0]);
  if (closing) {
    flash(`Цепочка не замыкается правильно. ${closing}`);
    return;
  }
  const pl = planeFromPoints(chain[0].p, chain[1].p, chain[2].p);
  if (!pl) {
    flash(`Первые три точки цепочки лежат на одной прямой, плоскость не определена. Цепочка: ${names}`);
    return;
  }
  // Расстояние до плоскости, а не знак: с какой стороны от неё точка, здесь
  // безразлично, важно только лежит ли она в плоскости.
  const offPlane = chain.filter((c) => Math.abs(planeSigned(pl, c.p)) > PLANE_EPS);
  if (offPlane.length) {
    flash(
      `Цепочка ${names} не лежит в одной плоскости. Вне неё: ${offPlane.map((c) => c.name).join(', ')}`
    );
    return;
  }

  store.commit((d) => {
    d.objects.push(makePlane(d, pl, sourceIds(chain), chain.map(pointNameAt)));
  });
  state.pending = [];
  syncPending();
  flash(`Плоскость построена по цепочке ${names}`);
}

/** Идентификаторы точек цепочки, чтобы плоскость знала, из чего собрана. */
function sourceIds(chain: PendingPoint[]): string[] {
  const ids: string[] = [];
  for (const c of chain) {
    const obj = store.pointAt(c.p);
    if (obj) ids.push(obj.id);
  }
  return ids;
}

function commitBatch(batch: PendingPoint[]): void {
  if (state.tool === 'point') {
    store.commit((d) => {
      const p = makePoint(d, batch[0].p, faceOf(store.solid, batch[0].p));
      d.objects.push(p);
    });
    return;
  }
  if (state.tool === 'line' || state.tool === 'segment') {
    // Два клика по одной точке не задают направление, и прямая с отрезком
    // схлопнулись бы в точку. Случай стал достижим, когда инструмент стал бить
    // строго по точкам: раньше второй клик всегда приходился на другое место.
    if (eq(batch[0].p, batch[1].p, 1e-4)) {
      flash(
        state.tool === 'segment'
          ? 'Отрезок строится по двум разным точкам'
          : 'Прямая строится по двум разным точкам'
      );
      return;
    }
    let freshLine: LineObj | null = null;
    store.commit((d) => {
      if (state.tool === 'segment') {
        d.objects.push(
          makeSegment(
            d,
            batch[0].p,
            batch[1].p,
            faceOf(store.solid, batch[0].p),
            [pointNameAt(batch[0]), pointNameAt(batch[1])]
          )
        );
      } else {
        freshLine = makeLine(d, batch[0].p, batch[1].p, faceOf(store.solid, batch[0].p));
        d.objects.push(freshLine);
      }
    });
    // Отрезок не отсекается: у него и так есть концы, а вот прямая при узле с
    // другой прямой сама получает точку и теряет хвост.
    if (freshLine) autoTrimAtCrossings(freshLine);
    return;
  }
  if (state.tool === 'plane') {
    // Режим без цепочки: плоскость по любым трём точкам.
    if (
      eq(batch[0].p, batch[1].p, 1e-4) ||
      eq(batch[1].p, batch[2].p, 1e-4) ||
      eq(batch[0].p, batch[2].p, 1e-4)
    ) {
      flash('Плоскость строится по трём разным точкам');
      return;
    }
    const pl = planeFromPoints(batch[0].p, batch[1].p, batch[2].p);
    if (!pl) {
      flash('Точки лежат на одной прямой, плоскость не определена');
      return;
    }
    store.commit((d) => {
      const obj = makePlane(d, pl, sourceIds(batch), batch.map(pointNameAt));
      d.objects.push(obj);
    });
    flash(`Плоскость построена по точкам ${batch.map((c) => c.name).join(', ')}`);
  }
}

/**
 * Имя точки для названия отрезка или плоскости.
 *
 * У этих инструментов целью клика всегда стоящая точка, поэтому в `PendingPoint`
 * имя уже есть. Поиск по координатам и генерация буквы - страховка на случай,
 * если точка оказалась безымянной: пустое имя в списке выглядело бы как ошибка,
 * а не как недоделанное построение.
 */
function pointNameAt(pt: PendingPoint): string {
  if (pt.name) return pt.name;
  const found = store.pointAt(pt.p);
  return found ? found.name : nextPointName(store.doc);
}

function flash(message: string): void {
  const el = $('#flash');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
let flashTimer: ReturnType<typeof setTimeout>;

function snapFacePoint(p: Vec3, faceIndex: number | null): Vec3 {
  if (faceIndex === null) return p;
  return snap(projectToFace(store.solid, p, faceIndex));
}

function pendingGroup(): THREE.Group {
  const g = new THREE.Group();
  state.pending.forEach((pt, i) => {
    const p = pt.p;
    // Первую точку цепочки красим иначе: замыкается цепочка кликом именно по
    // ней, и без отметки это неочевидно.
    const first = i === 0 && isChainMode();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(first ? 0.042 : 0.03, 14, 10),
      new THREE.MeshBasicMaterial({
        color: first ? COLOR.chainFirst : 0xffffff,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      })
    );
    m.position.set(p.x, p.y, p.z);
    m.renderOrder = 12;
    g.add(m);
    if (i > 0) {
      const prev = state.pending[i - 1].p;
      const link = fatLine(toV(prev), toV(p), 0xffffff, 0.006);
      link.renderOrder = 11;
      g.add(link);
    }
  });
  return g;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  viewer.setNdc(e, canvas);
  if (state.tool === 'select') {
    const hit = viewer.pickObject();
    if (hit) {
      store.toggleSelect(hit.id, e.shiftKey);
      state.drag = { id: hit.id, part: hit.part, moved: false };
      viewer.controls.enabled = false;
      return;
    }
    if (!e.shiftKey) store.selectOnly([]);
  } else if (state.tool === 'trim') {
    // Отсечение не идёт через resolveTarget: оно режет прямые, а не ставит точку.
    const targets = resolveTrimTargets();
    if (targets.length) applyTrim(targets);
    else flash(noTargetHint('trim', store.doc.solid));
  } else {
    const target = resolveTarget();
    if (target) onTargetClick(target);
    else flash(noTargetHint(state.tool, store.doc.solid));
  }
  updateHover();
  refresh();
});

canvas.addEventListener('pointermove', (e) => {
  viewer.setNdc(e, canvas);
  if (state.drag) {
    const obj = store.get(state.drag.id);
    if (obj) {
      const next = draggedPosition(obj, state.drag.part);
      if (next) {
        const id = state.drag.id;
        const part = state.drag.part;
        // В историю попадает только первый кадр перетаскивания, иначе одно
        // движение мыши забило бы стек отмены.
        store.update(id, (o) => applyDragTo(o, part, next), { history: !state.drag!.moved });
        state.drag.moved = true;
      }
    }
    return;
  }
  updateHover();
  viewer.requestRender();
});

function applyDragTo(obj: SceneObj, part: string, next: Vec3): void {
  if (obj.kind === 'point') obj.p = next;
  else if (obj.kind === 'line' || obj.kind === 'segment') {
    if (part === 'a') obj.a = next;
    else if (part === 'b') obj.b = next;
    // Отсечение записано точкой в пространстве, поэтому перенос конца делает его
    // бессмысленным: сбрасывается только сторона этого конца, вторая остаётся.
    if (obj.kind === 'line' && obj.trim) clearTrimEnd(obj, part === 'a' ? 'start' : 'end');
  } else if (obj.kind === 'plane') {
    obj.plane = {
      n: obj.plane.n,
      d: obj.plane.n.x * next.x + obj.plane.n.y * next.y + obj.plane.n.z * next.z,
    };
  }
}

/** Снимает одно отсечение, убирая `trim`, если оно стало последним. */
function clearTrimEnd(obj: LineObj, end: TrimEnd): void {
  if (!obj.trim) return;
  delete obj.trim[end];
  if (!obj.trim.start && !obj.trim.end) delete obj.trim;
}

/**
 * Точки ввода в статусной строке. Каждая вводная точка показывается фишкой, а
 * не общей строкой: их число видно сразу, и порядок ввода сохраняется.
 *
 * Постоянной подсказки рядом нет, поэтому строка появляется только когда есть
 * что показать, и не занимает место впустую.
 */
function syncPending(): void {
  const box = $('#pending');
  box.textContent = '';
  state.pending.forEach((pt, i) => {
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = pt.name ? `${i + 1} ${pt.name}` : String(i + 1);
    pin.title = fmt(pt.p);
    box.append(pin);
  });
  (box.parentElement as HTMLElement).classList.toggle('empty', !state.pending.length);
}

/** Режим цепочки: плоскость собирается по N точкам, а не по трём. */
function isChainMode(): boolean {
  return state.tool === 'plane' && state.chainEnabled;
}

function updateToolbar(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-tool]'))) {
    const on = btn.dataset.tool === state.tool;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-solid]'))) {
    const on = btn.dataset.solid === store.doc.solid;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  for (const id of ['#snap-toggle', '#chain-toggle']) {
    const el = $(id);
    const on = id === '#snap-toggle' ? state.snapEnabled : state.chainEnabled;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
  }
}

/**
 * Справка собирается из `help.ts`, а не живёт в разметке: текст должен
 * лежать рядом с остальными строками интерфейса и проверяться одним взглядом.
 */
/**
 * Переключатель фигур собирается из `SOLIDS_UI` и `SOLID_ICONS`, а не пишется в
 * разметке: список фигур, их названия и значки лежат в одном месте, иначе кнопки
 * разошлись бы с `SOLIDS` при первой же новой фигуре.
 *
 * Над кнопкой только значок: четыре названия занимали пол-панели. Имя остаётся в
 * подсказке и в `aria-label`, иначе фигура была бы немой для скринридера.
 */
function renderSolids(): void {
  const box = $('#solids');
  for (const s of SOLIDS_UI) {
    const btn = document.createElement('button');
    btn.className = 'action toggle solid';
    btn.dataset.solid = s.id;
    btn.innerHTML = SOLID_ICONS[s.id];
    btn.title = s.title;
    btn.setAttribute('aria-label', s.title);
    box.append(btn);
  }
}

/**
 * Рейка инструментов. Кнопки порождаются здесь, а не в разметке, потому что
 * подпись, клавиша и значок берутся из одной таблицы `TOOLS_UI` и `TOOL_ICONS`:
 * разъехавшиеся в разметке буквы и названия читались бы как разные инструменты.
 *
 * Порядок внутри кнопки задан сеткой в `styles.css`: клавиша, значок, название.
 */
function renderTools(): void {
  const box = $('#tools');
  for (const t of TOOLS_UI) {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.dataset.tool = t.id;
    btn.title = t.title;
    btn.setAttribute('aria-label', `${t.key} - ${t.title}`);
    const key = document.createElement('b');
    key.textContent = t.key;
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.innerHTML = TOOL_ICONS[t.id];
    const title = document.createElement('span');
    title.className = 'tool-title';
    title.textContent = t.title;
    btn.append(key, icon, title);
    box.append(btn);
  }
}

function renderHelp(): void {
  const list = $<HTMLDListElement>('#help-list');
  for (const row of [...HELP_TOOLS, ...HELP_VIEW]) {
    const pair = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = row.term;
    const text = document.createElement('dd');
    text.textContent = row.text;
    pair.append(term, text);
    list.append(pair);
  }
}

function renderObjectList(): void {
  const list = $('#objects');
  list.innerHTML = '';
  if (!store.doc.objects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `Пока пусто. Выберите инструмент и кликайте по граням ${solidGen(store.doc.solid)}.`;
    list.append(empty);
    return;
  }
  for (const obj of store.doc.objects) {
    const row = document.createElement('div');
    row.className = 'obj' + (store.selection.includes(obj.id) ? ' selected' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = obj.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = obj.name;
    const info = document.createElement('span');
    info.className = 'meta';
    info.textContent = describe(obj);
    // Буквы точек в строке легко принять за имя прямой, а имя у неё - своя
    // строчная буква. Подсказка снимает вопрос, не занимая места в списке.
    if (obj.kind === 'line') {
      const pts = linePoints(obj);
      info.title = pts
        ? `прямая через точки ${pts[0].name} и ${pts[1].name}`
        : 'прямая';
    }
    const eye = document.createElement('button');
    eye.className = obj.visible ? 'mini' : 'mini off';
    // Значка «закрытого глаза» в эмодзи нет, а красный 🚫 выбивается из тёмной
    // панели. Тот же глаз, но приглушённый - состояние читается по бледности.
    eye.innerHTML = ICON_EYE;
    eye.title = obj.visible ? 'Скрыть объект' : 'Показать объект';
    eye.setAttribute('aria-label', eye.title);
    eye.onclick = (e) => {
      e.stopPropagation();
      store.update(obj.id, (o) => {
        o.visible = !o.visible;
      });
    };
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.innerHTML = ICON_CROSS;
    // Угол фигуры неудаляем: кнопка остаётся видимой, но неактивной, иначе
    // непонятно, почему нажатие ничего не делает.
    del.disabled = !!obj.fixed;
    del.title = obj.fixed ? `Угол ${solidGen(store.doc.solid)} удалить нельзя` : 'Удалить';
    del.setAttribute('aria-label', del.title);
    del.onclick = (e) => {
      e.stopPropagation();
      store.remove([obj.id]);
    };
    row.onclick = (e) => store.toggleSelect(obj.id, e.shiftKey);
    // Двойной клик выбирает объект и ставит курсор в поле имени. Фокус сразу,
    // без отложенного кадра: перерисовка панели успевает заменить поле.
    row.ondblclick = (e) => {
      e.stopPropagation();
      store.selectOnly([obj.id]);
      if (!obj.fixed) $<HTMLInputElement>('#properties .name-input')?.focus();
    };
    row.append(dot, name, info, eye, del);
    list.append(row);
  }
}

/**
 * Точки, по которым проведена прямая, - их имена ищутся по координатам `a` и `b`.
 *
 * Прямая хранит только координаты опорных точек, а не их объекты: имена нужны
 * читателю списка, и тянуть в модель ссылки ради подписи незачем. Имена берутся
 * у текущего документа, а не запоминаются при создании, поэтому переименование
 * точки сразу видно в списке. Если точку удалили или конец прямой увели
 * перетаскиванием, опознать пару нельзя, и возвращается null: назвать прямую
 * по точке, через которую она больше не проходит, было бы враньём.
 */
function linePoints(obj: LineObj): [PointObj, PointObj] | null {
  const a = store.pointAt(obj.a);
  const b = store.pointAt(obj.b);
  return a && b ? [a, b] : null;
}

function describe(obj: SceneObj): string {
  if (obj.kind === 'point') return fmt(obj.p, 2);
  // Отметку об отсечении в список не кладу: она длиннее названия и вытесняет
  // его, а с каких сторон срезана прямая, видно в её свойствах.
  if (obj.kind === 'line') {
    // Прямая названа строчной буквой, и по ней не видно, через какие точки
    // она проведена. Две буквы говорят больше, чем слово «прямая», а имена
    // углов фигуры пользователь уже знает.
    const pts = linePoints(obj);
    return pts ? `${pts[0].name}${pts[1].name}` : 'прямая';
  }
  if (obj.kind === 'segment') return `отрезок ${dist(obj.a, obj.b).toFixed(2)}`;
  const hits = planeEdgePoints(store.solid, obj.plane);
  return `пересечений: ${hits.length}`;
}

/** Отсечения прямой как список «сторона, точка». */
function trimSides(obj: LineObj): [TrimEnd, Vec3][] {
  const out: [TrimEnd, Vec3][] = [];
  if (obj.trim?.start) out.push(['start', obj.trim.start]);
  if (obj.trim?.end) out.push(['end', obj.trim.end]);
  return out;
}

/**
 * Блоки отсечения в свойствах прямой. Стороны снимаются по отдельности, иначе
 * нельзя вернуть одну, оставив вторую.
 *
 * Кнопки нужны помимо инструмента: отсечение по узлу снимается точно, а кликом
 * инструментом пришлось бы целиться в ту же точку на экране. Отрезки сюда не
 * попадают - у них концы и так заданы.
 */
function trimControls(obj: LineObj): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'trim';
  const sides = trimSides(obj);
  if (sides.length) {
    for (const [end, p] of sides) {
      const from = end === 'start' ? 'начала' : 'конца';
      const side = document.createElement('div');
      side.className = 'trim-side';
      side.append(readout(`Отсечено с ${from}`, fmt(p)));
      const back = document.createElement('button');
      back.className = 'action';
      back.textContent = `Вернуть хвост с ${from}`;
      back.onclick = () =>
        store.update(obj.id, (o) => {
          if (o.kind === 'line') clearTrimEnd(o, end);
        });
      side.append(back);
      wrap.append(side);
    }
    return wrap;
  }
  const btn = document.createElement('button');
  btn.className = 'action';
  btn.textContent = 'Отсечь по узлам с другими прямыми';
  btn.onclick = () => autoTrimAtCrossings(obj);
  wrap.append(btn);
  return wrap;
}

function draggedPosition(obj: SceneObj, part: string): Vec3 | null {
  if (obj.fixed) return null;
  if (obj.kind === 'point' || obj.kind === 'line' || obj.kind === 'segment') {
    const target = resolveTarget();
    if (!target) return null;
    if (obj.face === null || target.faceIndex === null) return target.p;
    // Точка остаётся на своей грани, пока курсор явно не ушёл глубже в другую,
    // иначе перетаскивание переворачивало бы объект через всю фигуру.
    if (target.faceIndex === obj.face) return target.p;
    const here = viewer.faceDepth(target.p, obj.face);
    const there = viewer.faceDepth(target.p, target.faceIndex);
    return there > here + 0.05 ? target.p : snapFacePoint(target.p, obj.face);
  }
  if (obj.kind === 'plane') {
    return viewer.rayToPlane(toV(obj.plane.n), -obj.plane.d);
  }
  return null;
}

function planeEquationText(n: Vec3, d: number): string {
  const term = (coef: number, axis: string) => {
    if (Math.abs(coef) < 1e-9) return null;
    const sign = coef < 0 ? '−' : '+';
    return `${sign} ${Math.abs(coef).toFixed(3)}${axis}`;
  };
  const parts = [term(n.x, 'x'), term(n.y, 'y'), term(n.z, 'z')].filter(
    (p): p is string => p !== null
  );
  const body = parts.length
    ? parts.map((p, i) => (i === 0 ? p.replace(/^[+−] /, '') : p)).join(' ')
    : '0';
  const rhs = Math.abs(d) < 1e-9 ? '0' : d.toFixed(3);
  return `${body} = ${rhs}`;
}

function renderProperties(): void {
  const box = $('#properties');
  const sel = store.selected();
  box.innerHTML = '';
  if (!sel.length) {
    box.innerHTML = '<div class="empty">Объект не выбран</div>';
    return;
  }
  for (const obj of sel) {
    const card = document.createElement('div');
    card.className = 'card';
    card.append(nameField(obj));
    if (obj.kind === 'point') {
      card.append(vecInputs('Координаты', obj.p, (p) => store.update(obj.id, (o) => {
        if (o.kind === 'point') o.p = p;
      })));
    } else if (obj.kind === 'line' || obj.kind === 'segment') {
      // Отсечение живёт точкой в пространстве, поэтому перенос конца сбрасывает
      // только свою сторону, вторая остаётся.
      const setEnd = (key: 'a' | 'b') => (p: Vec3) =>
        store.update(obj.id, (o) => {
          if (o.kind !== 'line' && o.kind !== 'segment') return;
          o[key] = p;
          if (o.kind === 'line') clearTrimEnd(o, key === 'a' ? 'start' : 'end');
        });
      card.append(vecInputs('Точка A', obj.a, setEnd('a')));
      card.append(vecInputs('Точка B', obj.b, setEnd('b')));
      if (obj.kind === 'line') card.append(trimControls(obj));
    } else {
      card.append(
        readout('Уравнение', planeEquationText(obj.plane.n, obj.plane.d)),
      );
      const poly = sectionPolygon(store.solid, obj.plane);
      card.append(
        readout(
          'Сечение',
          poly.length
            ? `${poly.length}-угольник, вершины ${poly.map((p) => fmt(p, 2)).join(' ')}`
            : `Плоскость не пересекает ${solidGen(store.doc.solid)} по площади`,
        ),
      );
      const btn = document.createElement('button');
      btn.className = 'action';
      btn.textContent = 'Добавить точки пересечения в сцену';
      btn.onclick = () => {
        const pts = planeEdgePoints(store.solid, obj.plane);
        if (!pts.length) {
          flash('Нет пересечений с рёбрами');
          return;
        }
        store.commit((d) => {
          for (const p of pts) d.objects.push(makePoint(d, p, faceOf(store.solid, p)));
        });
        flash(`Добавлено точек: ${pts.length}`);
      };
      card.append(btn);
    }
    box.append(card);
  }
}

/**
 * Неизменяемый текст в свойствах: та же подпись и та же ямка, что у полей
 * ввода, иначе уравнение и вершины сечения читаются как случайный блок.
 */
function readout(label: string, text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = label;
  const body = document.createElement('div');
  body.className = 'eq';
  body.textContent = text;
  wrap.append(l, body);
  return wrap;
}

/**
 * Поле имени объекта. Подпись берётся отсюда же, что и из списка, поэтому
 * переименование сразу видно на самой сцене.
 */
function nameField(obj: SceneObj): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = obj.fixed ? `Имя (угол ${solidGen(store.doc.solid)})` : 'Имя';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'name-input';
  input.value = obj.name;
  input.maxLength = 24;
  // enter и blur фиксируют имя, escape возвращает прежнее и снимает фокус,
  // иначе переименование терялось бы при перерисовке панели.
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = obj.name;
      input.blur();
    }
    e.stopPropagation();
  };
  input.onchange = () => store.rename(obj.id, input.value);
  wrap.append(l, input);
  return wrap;
}

function vecInputs(label: string, value: Vec3, onChange: (p: Vec3) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = label;
  wrap.append(l);
  const row = document.createElement('div');
  row.className = 'inputs';
  (['x', 'y', 'z'] as const).forEach((axis, i) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.05';
    input.value = value[axis].toFixed(3);
    input.onchange = () => {
      const n = parseFloat(input.value);
      if (Number.isNaN(n)) return;
      const next = v3(value.x, value.y, value.z);
      if (axis === 'x') next.x = n;
      if (axis === 'y') next.y = n;
      if (axis === 'z') next.z = n;
      onChange(next);
    };
    const cell = document.createElement('label');
    cell.className = 'axis-' + axis;
    cell.innerHTML = `<span>${axis.toUpperCase()}</span>`;
    cell.append(input);
    row.append(cell);
    void i;
  });
  wrap.append(row);
  return wrap;
}

function refresh(): void {
  // Фигура могла смениться и отменой, поэтому сцена приводится к ней здесь, а
  // не только в обработчике кнопки: иначе Ctrl+Z вернул бы куб с точками
  // тетраэдра.
  viewer.setSolid(store.solid);
  viewer.setObjectGroup(buildScene(store.solid, store.doc, store.selection, viewer.clip));
  viewer.setOverlay(pendingGroup());
  // setOverlay пересобирает группу, поэтому превью приходится применять заново.
  updateHover();
  renderObjectList();
  renderProperties();
  ($('#undo') as HTMLButtonElement).disabled = !store.canUndo;
  ($('#redo') as HTMLButtonElement).disabled = !store.canRedo;
  viewer.requestRender();
}

window.addEventListener('pointerup', () => {
  if (state.drag) {
    state.drag = null;
    viewer.controls.enabled = true;
  }
});

canvas.addEventListener('pointerleave', () => {
  state.hoverInfo = '';
  $('#cursor-info').textContent = '';
});

// Обработчик один на контейнер, как у фигур: кнопки порождаются `renderTools`
// ниже по файлу, и навешенный на них в момент запуска обработчик повис бы в
// пустоте.
$('#tools').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]');
  if (btn) setTool(btn.dataset.tool as Tool);
});

/**
 * Смена фигуры. Чертёж прежней фигуры стирается, и спрашивается об этом только
 * когда есть что терять: углы остаются при любой фигуре, и по длине списка их
 * наличие не видно. Незавершённый ввод сбрасывается, потому что цепочка
 * предыдущей фигуры к новой отношения не имеет.
 *
 * Обработчик один на контейнер, а не на каждую кнопку: кнопки порождаются
 * `renderSolids` ниже по файлу, и навешенный на них обработчик в момент запуска
 * повис бы в пустоте.
 */
$('#solids').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-solid]');
  if (!btn) return;
  const id = btn.dataset.solid as SolidId;
  if (id === store.doc.solid) return;
  if (store.hasContent() && !confirm('Сменить фигуру? Чертёж будет очищен.')) return;
  store.setSolid(id);
  state.pending = [];
  syncPending();
  setTool('select');
  viewer.fit();
});

$('#snap-toggle').onclick = () => {
  state.snapEnabled = !state.snapEnabled;
  updateToolbar();
};

// Переключение режима сбрасывает ввод: цепочка на три точки и цепочка по
// правилам - разные незавершённые построения, и смешивать их нельзя.
$('#chain-toggle').onclick = () => {
  state.chainEnabled = !state.chainEnabled;
  state.pending = [];
  syncPending();
  updateToolbar();
  refresh();
};

$('#undo').onclick = () => store.undo();
$('#redo').onclick = () => store.redo();
$('#clear').onclick = () => {
  // Подтверждение спрашивают только когда есть что стирать: углы фигуры
  // переживают очистку, и по длине списка это не видно.
  if (store.hasContent() && confirm('Очистить всю сцену?')) {
    store.clear();
    setTool('select');
  }
};
$('#cancel').onclick = () => {
  state.pending = [];
  syncPending();
  setTool('select');
};
$('#delete-selected').onclick = () => {
  if (store.selection.length) store.remove(store.selection);
};
// Положение камеры живёт в `Viewer.fit`, а не здесь: смена фигуры ставит вид так
// же, как кнопка, и две копии одного расчёта разошлись бы с фигурой.
$('#fit').onclick = () => viewer.fit();

// Справка живёт в отдельном окне и держится, пока его не закрыли: список
// управления длинный, а мигающая подсказка в углу сцены для него не годится.
const help = $<HTMLDialogElement>('#help');
$('#help-open').onclick = () => help.showModal();
$('#help-close').onclick = () => help.close();

// Клавиши инструментов различаем по физическому коду, а не по букве: `e.key`
// отдаёт символ текущей раскладки, и при русской Q, W, E печатали бы «й», «ц»,
// «у». Клавиши подписаны латиницей, значит и набирать их надо латиницей. Сама
// раскладка выводится из `TOOLS_UI`, поэтому буква в рейке и здесь не разойдутся.
const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOLS_UI.map((t) => [`Key${t.key}`, t.id])
);

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  // Ввод имени перехватывает клавиши: иначе Escape сбрасывал бы инструмент,
  // а буквы-горячие клавиши переключали инструменты прямо во время набора.
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
  // Открытая справка перехватывает клавиши, иначе буквы-горячие клавиши
  // переключали инструменты под модальным окном, а Escape закрыл его и заодно
  // сбросил инструмент.
  if (help.open) return;
  const key = e.code;
  if ((e.ctrlKey || e.metaKey) && key === 'KeyZ') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  // Backspace откатывает последнюю точку ввода, пока цепочка или прямая не
  // дописаны. Без этого ошибка в середине цепочки стоила бы только сброса
  // всего ввода кнопкой.
  if (key === 'Backspace' && state.pending.length) {
    state.pending.pop();
    syncPending();
    refresh();
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (store.selection.length) store.remove(store.selection);
    return;
  }
  if (key === 'Escape') {
    state.pending = [];
    syncPending();
    setTool('select');
    return;
  }
  if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
});

window.addEventListener('resize', () => {
  viewer.resize();
  viewer.start();
});

/**
 * Демо-заготовка: плоскость через начало координат с нормалью, своей у каждой
 * фигуры, и точки её пересечения с рёбрами. Точки берутся из той же геометрии,
 * что и любой чертёж, поэтому демо не может разойтись с правилами: у фигуры,
 * для которой нормаль даёт меньше трёх пересечений, сечение не появится.
 */
$('#demo').onclick = () => {
  const solid = store.solid;
  const n = norm(DEMO_NORMAL[store.doc.solid]);
  if (!n) return;
  const pl: Plane = { n, d: 0 };
  const pts = sectionPolygon(solid, pl);
  if (pts.length < 3) {
    flash(`Плоскость не пересекает ${solidGen(store.doc.solid)} по площади`);
    return;
  }
  store.commit((d) => {
    // Имена берутся у только что созданных точек: иначе плоскость получила бы
    // имя из пустого списка.
    const names = pts.map((p) => {
      const obj = makePoint(d, p, faceOf(solid, p));
      d.objects.push(obj);
      return obj.name;
    });
    d.objects.push(makePlane(d, pl, [], names));
  });
  setTool('select');
  flash(DEMO.done(pts.length));
};

store.subscribe(() => refresh());
renderSolids();
renderTools();
renderHelp();
// Углы фигуры создаются при старте: они задают систему координат и служат
// точками привязки для прямых и плоскостей.
store.commit((d) => addCorners(d, store.solid), { history: false });
setTool('select');
syncPending();
viewer.fit();
// Отладочный доступ для скриптов в tmp/: поля лежат на window и ни на что в
// приложении не влияют.
(window as unknown as Record<string, unknown>).__viewer = viewer;
(window as unknown as Record<string, unknown>).__store = store;
refresh();
viewer.start();
