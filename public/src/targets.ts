/**
 * Выбор цели и правила построения: что окажется под курсором, чем это
 * обернётся и что из этого попадёт в документ.
 *
 * Живут здесь и магниты, и отсечение, и цепочка сечения, потому что все три
 * решают одну задачу - куда встанет точка и что из этого получится. Отрисовка и
 * мышь лежат отдельно и приходят сюда только за ответом.
 */
import {
  dist,
  eq,
  faceOf,
  fmt,
  insideSolid,
  lineEdgeHits,
  lineFromPoints,
  lineIntersect,
  planeFromPoints,
  planeSigned,
  pointFaces,
  pointOnSegment,
  projectToFace,
  snapToSolid,
  trimEndOf,
  trimmedSpan,
  type Line3,
  type TrimEnd,
  type Vec3,
} from './geometry';
import {
  makeLine,
  makePlane,
  makePoint,
  makeSegment,
  nextPointName,
  type LineObj,
  type PointObj,
  type SegmentObj,
  type Tool,
} from './model';
import { solidGen, trimDone, trimHint } from './hints';
import { flash, state, store, syncPending, viewer, type PendingPoint } from './app';

const MAGNET_RADIUS = 0.16;
const CROSS_RADIUS = 0.12;
// При выключенном притяжении магнит пропадает, но «Прямая» и «Плоскость» без
// него не работают вовсе: остаётся требование попасть в саму точку, а не рядом.
const PICK_RADIUS = 0.06;
// Допуск проверки принадлежности плоскости. Точки прилипают к рёбрам и вершинам,
// поэтому координаты копятся с точностью магнита, а не машины.
const PLANE_EPS = 1e-3;

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
export type Target = {
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

/** Снимает одно отсечение, убирая `trim`, если оно стало последним. */
export function clearTrimEnd(obj: LineObj, end: TrimEnd): void {
  if (!obj.trim) return;
  delete obj.trim[end];
  if (!obj.trim.start && !obj.trim.end) delete obj.trim;
}

export function snapFacePoint(p: Vec3, faceIndex: number | null): Vec3 {
  if (faceIndex === null) return p;
  return snap(projectToFace(store.solid, p, faceIndex));
}

function snap(p: Vec3): Vec3 {
  return state.snapEnabled ? snapToSolid(store.solid, p).p : p;
}

/** Режим цепочки: плоскость собирается по N точкам, а не по трём. */
export function isChainMode(): boolean {
  return state.tool === 'plane' && state.chainEnabled;
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
export function resolveTrimTargets(): TrimTarget[] {
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

export function resolveTarget(): Target | null {
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

export function updateHover(): void {
  const info = document.querySelector('#cursor-info') as HTMLElement;
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
export function applyTrim(targets: TrimTarget[]): void {
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
export function autoTrimAtCrossings(fresh: LineObj): void {
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

/**
 * Клик по цели. В режиме цепочки клики не собирают плошку, а наращивают
 * цепочку сечения, поэтому маршрут выбирается здесь, а не внутри `pushPending`.
 *
 * Перерисовку вызывает обработчик клика: он идёт по цепочке вверх и обновляет
 * сцену целиком, поэтому своя копия `refresh` здесь была бы лишней.
 */
export function onTargetClick(target: Target): void {
  if (isChainMode()) {
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
