/**
 * Мышь на сцене: клик по цели, перетаскивание объектов и превью под курсором.
 *
 * Куда попал клик, решает `targets`, поэтому отсюда видны только три вещи: кого
 * ударили, что с ним сделали и когда пора перерисовать сцену. Само перерисовывание
 * приходит параметром, иначе модуль мыши пришлось бы импортировать точку входа.
 */
import type { LineObj, PointMove, PointObj, SceneObj, SegmentObj } from './model';
import {
  GRID_STEP,
  mul,
  snapToGrid,
  snapToGridOnFace,
  type Vec3,
} from './geometry';
import { noTargetHint, planeDroppedHint, solidFaultHint } from './hints';
import { toV } from './objects3d';
import { canvas, flash, state, store, viewer } from './app';
import {
  applyTrim,
  clearTrimEnd,
  onTargetClick,
  resolveTarget,
  resolveTrimTargets,
  snapFacePoint,
  updateHover,
  type Target,
} from './targets';

/**
 * Вешает обработчики указателя на канву и окно.
 *
 * `redraw` зовётся после каждого действия, которое меняет сцену: подписка на
 * документ покрывает только правки чертёжа, а перетаскивание и превью идут
 * мимо `Store`.
 */
export function bindPointer(redraw: () => void): void {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    viewer.setNdc(e, canvas);
    if (state.tool === 'select') {
      const hit = viewer.pickObject();
      if (hit) {
        // Ctrl, а не Shift: Shift при перетаскивании ведёт объект по сетке, и
        // множественный выбор остался бы недостижим.
        store.toggleSelect(hit.id, e.ctrlKey || e.metaKey);
        state.drag = { id: hit.id, part: hit.part, moved: false, refused: false, told: false };
        viewer.controls.enabled = false;
        return;
      }
      if (!e.ctrlKey && !e.metaKey) store.selectOnly([]);
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
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    viewer.setNdc(e, canvas);
    if (state.drag) {
      const obj = store.get(state.drag.id);
      if (obj) {
        const next = draggedPosition(obj, state.drag.part, e.shiftKey);
        if (next) {
          const id = state.drag.id;
          const part = state.drag.part;
          // В историю попадает только первый кадр перетаскивания, иначе одно
          // движение мыши забило бы стек отмены.
          const history = !state.drag.moved;
          // Угол фигуры идёт через `moveCorner`: тот проверяет, что фигура из новых
          // вершин ещё собирается, иначе сцена осталась бы с углом, которого нет.
          const { fault, dropped } = moveObject(id, part, next, history);
          if (fault) {
            // Сообщение одно на всё перетаскивание: угол отказывают десятки кадров
            // подряд, и мигающая плашка забила бы собой всё остальное.
            if (!state.drag.refused) {
              state.drag.refused = true;
              flash(solidFaultHint(fault));
            }
            return;
          }
          // Плоскость уходит вместе с её точкой, и сказать об этом надо один раз:
          // дальше кадры идут по той же точке и убирать больше нечего.
          if (dropped.length && !state.drag.told) {
            state.drag.told = true;
            flash(planeDroppedHint(dropped));
          }
          state.drag.moved = true;
          state.drag.refused = false;
        }
      }
      return;
    }
    updateHover();
    viewer.requestRender();
  });

  window.addEventListener('pointerup', () => {
    if (state.drag) {
      state.drag = null;
      viewer.controls.enabled = true;
    }
  });

  canvas.addEventListener('pointerleave', () => {
    state.hoverInfo = '';
    (document.querySelector('#cursor-info') as HTMLElement).textContent = '';
  });
}

/**
 * Сдвиг объекта при перетаскивании.
 *
 * Угол фигуры идёт через `moveCorner`: тот проверяет, что фигура из новых вершин
 * ещё собирается, иначе сцена осталась бы с углом, которого нет. Обычная точка
 * идёт через `movePoint`, а не через `update`, потому что сдвиг уносит
 * построенные по ней плоскости, и делать это должен `Store`.
 */
function moveObject(id: string, part: string, next: Vec3, history: boolean): PointMove {
  const obj = store.get(id);
  if (obj?.kind === 'point' && obj.fixed) return store.moveCorner(id, next, { history });
  if (obj?.kind === 'point') return store.movePoint(id, next, { history });
  store.update(id, (o) => applyDragTo(o, part, next), { history });
  return { fault: null, dropped: [] };
}

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

/**
 * Куда встал бы объект под курсором.
 *
 * Угол фигуры тянется свободно, в плоскости экрана: он не принадлежит ни одной
 * грани, и притягивание к грани заставляло бы перескакивать между ними при
 * пересечении края. Остальные объекты по-прежнему прилипают к своим граням, иначе
 * точка соскочила бы с грани в воздух.
 *
 * Сетка (`grid`) привязывает каждую координату к узлу, и именно поэтому с неё
 * выходит параллелепипед: сдвинутые углы встают на одни и те же значения, а не
 * на соседние десятые доли. У точки и конца линии координата по нормали грани
 * не привязывается, а выводится из плоскости - иначе привязка увела бы точку с
 * грани, и дальше по ней ничего не построилось бы.
 */
function draggedPosition(obj: SceneObj, part: string, grid: boolean): Vec3 | null {
  if (obj.fixed) {
    const p = obj.kind === 'point' ? viewer.rayThroughScreen(obj.p) : null;
    return p && grid ? snapToGrid(p) : p;
  }
  if (obj.kind === 'point' || obj.kind === 'line' || obj.kind === 'segment') {
    const target = resolveTarget();
    if (!target) return null;
    const p = onOwnFace(obj, target);
    if (!grid) return p;
    return obj.face === null
      ? snapToGrid(p)
      : snapToGridOnFace(store.solid, p, obj.face);
  }
  if (obj.kind === 'plane') {
    const p = viewer.rayToPlane(toV(obj.plane.n), -obj.plane.d);
    if (!p || !grid) return p;
    // У плоскости привязывается расстояние от начала координат: точка на сетке
    // по нормали и есть узел, через который проходит плоскость.
    return mul(obj.plane.n, Math.round(obj.plane.d / GRID_STEP) * GRID_STEP);
  }
  return null;
}

/**
 * Точка остаётся на своей грани, пока курсор явно не ушёл глубже в другую,
 * иначе перетаскивание переворачивало бы объект через всю фигуру.
 */
function onOwnFace(obj: PointObj | LineObj | SegmentObj, target: Target): Vec3 {
  if (obj.face === null || target.faceIndex === null) return target.p;
  if (target.faceIndex === obj.face) return target.p;
  const here = viewer.faceDepth(target.p, obj.face);
  const there = viewer.faceDepth(target.p, target.faceIndex);
  return there > here + 0.05 ? target.p : snapFacePoint(target.p, obj.face);
}
