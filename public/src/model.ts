import {
  DEFAULT_SOLID,
  SOLIDS,
  clone,
  eq,
  reshapeSolid,
  type Plane,
  type Solid,
  type SolidFault,
  type SolidId,
  type Trims,
  type Vec3,
} from './geometry';
import { COLOR, cssColor } from './colors';

export type Tool = 'select' | 'point' | 'line' | 'segment' | 'plane' | 'trim';

export interface BaseObj {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /**
   * Угловая точка фигуры. Её нельзя удалить, но можно сдвинуть: сдвиг меняет саму
   * фигуру, и из куба получается параллелепипед. Имена у углов свои, из углов
   * фигуры, поэтому пользовательские точки начинаются с E и не занимают буквы
   * углов.
   */
  fixed?: boolean;
}

export interface PointObj extends BaseObj {
  kind: 'point';
  p: Vec3;
  face: number | null;
  /**
   * Индекс вершины фигуры, если это угол. По нему вершина собирается заново при
   * сдвиге угла, иначе фигура и её углы разошлись бы: подпись грани и
   * подсветка смотрели бы на прежние вершины, а на сцене стояли бы новые.
   */
  corner?: number;
}

/**
 * Прямая. По умолчанию бесконечна, но `trim` хранит точки отсечения - по одной
 * на сторону: `start` убирает хвост за точкой, `end` перед точкой. Стороны
 * независимы, поэтому у прямой может быть отсечение с одной стороны или с обеих.
 * Сами отрезки не хранятся: из точек и хорды куба они пересобираются в
 * `trimmedSpan`.
 */
export interface LineObj extends BaseObj {
  kind: 'line';
  a: Vec3;
  b: Vec3;
  face: number | null;
  trim?: Trims;
}

/**
 * Отрезок: та же пара точек, что у прямой, но с концами. В отличие от прямой
 * он не продолжается за них, поэтому сечение, построенное по отрезкам,
 * не вылезает за пределы того, что нарисовано.
 */
export interface SegmentObj extends BaseObj {
  kind: 'segment';
  a: Vec3;
  b: Vec3;
  face: number | null;
}

export interface PlaneObj extends BaseObj {
  kind: 'plane';
  plane: Plane;
  sourceIds: string[];
}

export type SceneObj = PointObj | LineObj | SegmentObj | PlaneObj;

export interface Doc {
  /**
   * Фигура сцены. Лежит в документе, а не в состоянии инструментов: смена
   * фигуры должна отменяться вместе с остальными правками, иначе Ctrl+Z
   * вернул бы чертёж, которого на экране уже нет.
   */
  solid: SolidId;
  objects: SceneObj[];
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

// Углы фигуры занимают A, B, C, D, поэтому пользовательские точки
// продолжают с E. Прямые идут строчными a, b, c - так же, как их принято
// обозначать в тетради по стереометрии. Отрезки и плоскости именуются по
// своим точкам, см. `uniqueName`.
const POINT_LETTERS = 'EFGHIJKLMNOPQRSTUVWXYZ'.split('');
const LINE_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Первая свободная буква из заданного алфавита. Занятые имена, в том числе
 * переименованные вручную, пропускаются, поэтому подпись не может
 * задвоиться.
 */
function nextFreeName(doc: Doc, letters: string[]): string {
  const taken = new Set(doc.objects.map((o) => o.name));
  for (const letter of letters) {
    if (!taken.has(letter)) return letter;
  }
  // Алфавит кончился: продолжаем двухбуквенными именами E1, F1, ...
  for (let round = 1; ; round++) {
    for (const letter of letters) {
      const name = `${letter}${round}`;
      if (!taken.has(name)) return name;
    }
  }
}

/** Имя новой точки по алфавиту, начиная с E: углы фигуры занимают A, B, C, D. */
export function nextPointName(doc: Doc): string {
  return nextFreeName(doc, POINT_LETTERS);
}

/** Имя новой прямой строчными: в стереометрии это разные обозначения с точками. */
export function nextLineName(doc: Doc): string {
  return nextFreeName(doc, LINE_LETTERS);
}

/**
 * Имя из готовых букв, не занятое в сцене: `AE`, `ABCE`. Два одинаковых отрезка
 * или две одинаковые плоскости возможны, поэтому повтор получает номер - `AE2`.
 * Иначе в списке объектов появились бы две строки с одним именем.
 */
function uniqueName(doc: Doc, base: string): string {
  const taken = new Set(doc.objects.map((o) => o.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}${n}`;
    if (!taken.has(name)) return name;
  }
}

export function makePoint(
  doc: Doc,
  p: Vec3,
  face: number | null,
  opts: { name?: string; fixed?: boolean; corner?: number } = {}
): PointObj {
  return {
    id: nextId('pt'),
    // Угол фигуры приходит со своим именем из её нотации, иначе он получил бы
    // букву из пользовательского алфавита и занял её.
    name: opts.name ?? nextPointName(doc),
    color: cssColor(COLOR.point),
    visible: true,
    kind: 'point',
    p,
    face,
    fixed: opts.fixed,
    corner: opts.corner,
  };
}

/**
 * Углы фигуры её же нотацией: у параллелепипеда ABCDA₁B₁C₁D₁, у тетраэдра
 * ABCD. Имена берутся из фигуры, поэтому смена фигуры не требует второго
 * списка углов, а буквы у всех фигур одни и те же - пользовательские точки
 * начинаются с E при любой из них.
 */
export function addCorners(doc: Doc, solid: Solid): void {
  for (const c of solid.corners) {
    const p = solid.vertices[c.index];
    doc.objects.push(
      makePoint(doc, p, null, { name: c.name, fixed: true, corner: c.index })
    );
  }
}

export function makeLine(doc: Doc, a: Vec3, b: Vec3, face: number | null): LineObj {
  return {
    id: nextId('ln'),
    name: nextLineName(doc),
    color: cssColor(COLOR.line),
    visible: true,
    kind: 'line',
    a,
    b,
    face,
  };
}

/**
 * Имя нового отрезка складывается из имён его концов: отрезок A–E называется
 * `AE`, как его и записывают в тетради. Концы приходят по именам, а не по
 * координатам: точка может быть переименована, и тогда AE честнее AB.
 */
export function makeSegment(
  doc: Doc,
  a: Vec3,
  b: Vec3,
  face: number | null,
  endNames: [string, string]
): SegmentObj {
  return {
    id: nextId('sg'),
    name: uniqueName(doc, endNames.join('')),
    color: cssColor(COLOR.segment),
    visible: true,
    kind: 'segment',
    a,
    b,
    face,
  };
}

/**
 * Имя плоскости складывается из имён её точек: `ABCE`.
 *
 * Замыкающая точка цепочки повторяет первую, но в имя не входит: она нужна
 * только чтобы показать, что пользователь хочет замкнуть контур. Плоскость
 * называется по вершинам сечения один раз.
 */
export function makePlane(
  doc: Doc,
  plane: Plane,
  sourceIds: string[],
  pointNames: string[]
): PlaneObj {
  return {
    id: nextId('pl'),
    name: uniqueName(doc, pointNames.join('')),
    color: cssColor(COLOR.plane),
    visible: true,
    kind: 'plane',
    plane,
    sourceIds,
  };
}

type Listener = (doc: Doc) => void;

export class Store {
  doc: Doc = { solid: DEFAULT_SOLID, objects: [] };
  selection: string[] = [];
  private undoStack: Doc[] = [];
  private redoStack: Doc[] = [];
  private listeners = new Set<Listener>();
  /**
   * Собранная фигура при неизменном документе. За один `refresh` к `store.solid`
   * обращаются несколько раз, и без кеша каждый раз вышла бы новая ссылка: её
   * потом сравнивал бы `Viewer.setSolid` и пересобирал сцену заново.
   */
  private solidCache: Solid | null = null;

  /**
   * Фигура текущего документа: геометрия всегда берётся отсюда.
   *
   * Вершины берутся у углов сцены, а не из палитры `SOLIDS`, поэтому сдвинутый
   * угол меняет саму фигуру. Пока углы на местах, отдаётся та же ссылка, что и у
   * фигуры-образца: `Viewer.setSolid` сравнивает по ссылке, и новый объект на
   * каждое обновление заставлял бы пересобирать сцену целиком. `store.solid`
   * берут все, и каждый чих заново собирать шесть граней было бы заметно.
   */
  get solid(): Solid {
    if (this.solidCache) return this.solidCache;
    const base = SOLIDS[this.doc.solid];
    const corners = this.corners();
    // Пока углы на местах, отдаётся та же ссылка, что и у фигуры-образца:
    // `Viewer.setSolid` сравнивает по ссылке, и новый объект на каждое обновление
    // заставлял бы пересобирать сцену целиком.
    if (corners.every((p, i) => eq(p, base.vertices[i]))) this.solidCache = base;
    else {
      const fit = reshapeSolid(base, corners);
      // Отказ означает, что документ держит вершины, из которых фигура не
      // собирается. Такое бывает только если углы двигали в обход `moveCorner`,
      // иначе он бы откатил их. Рисуем образец, а не поломанную фигуру.
      this.solidCache = fit.ok ? fit.solid : base;
    }
    return this.solidCache;
  }

  /**
   * Вершины фигуры по углам сцены. Углов может не быть вовсе - документ с
   * пустым списком углов собирается из фигуры-образца, иначе проверка на
   * совпадение вершин падала бы на длине нуля.
   */
  private corners(): Vec3[] {
    const base = SOLIDS[this.doc.solid];
    const out = base.vertices.map(clone);
    for (const o of this.doc.objects) {
      if (o.kind === 'point' && o.corner !== undefined) out[o.corner] = o.p;
    }
    return out;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    // Документ изменился, значит собранная фигура больше не годится. Кеш
    // сбрасывается здесь, а не в каждом месте правки: забытый сброс означал бы,
    // что `store.solid` молча рисует по устаревшим вершинам.
    this.solidCache = null;
    for (const fn of this.listeners) fn(this.doc);
  }

  commit(mutate: (doc: Doc) => void, opts: { history?: boolean } = {}): void {
    const withHistory = opts.history !== false;
    if (withHistory) {
      this.undoStack.push(structuredClone(this.doc));
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    // До правки, а не после: внутри `mutate` читают `store.solid` и по уже
    // изменённым вершинам - так `moveCorner` проверяет фигуру, не собирая её
    // дважды.
    this.solidCache = null;
    mutate(this.doc);
    this.emit();
  }

  replaceDoc(doc: Doc): void {
    this.undoStack.push(structuredClone(this.doc));
    this.redoStack.length = 0;
    this.doc = doc;
    this.selection = [];
    this.emit();
  }

  /**
   * Правка одного объекта по id. Объект ищется внутри `commit`, иначе правка
   * осталась бы в старой копии документа и её затёр бы следующий `commit`.
   */
  update(
    id: string,
    mutate: (obj: SceneObj) => void,
    opts: { history?: boolean } = {}
  ): void {
    this.commit((d) => {
      const obj = d.objects.find((o) => o.id === id);
      if (obj) mutate(obj);
    }, opts);
  }

  /** Точка, стоящая в этих координатах: имена точек ищутся по положению. */
  pointAt(p: Vec3, eps = 1e-4): PointObj | undefined {
    return this.doc.objects.find(
      (o): o is PointObj => o.kind === 'point' && eq(o.p, p, eps)
    );
  }

  /**
   * Сдвиг угла фигуры. Возвращает причину отказа, если фигура из новых вершин не
   * получилась, и `null` при удаче.
   *
   * Проверка живёт здесь, а не в обработчике: отказ не должен оставлять угол в
   * положении, из которого фигура не собирается, - иначе грани, рёбра и сечение
   * считали бы по вывернутой фигуре. Правка идёт одним `update` вместе с
   * пересборкой, иначе на одно перетаскивание вышло бы два шага отмены: сначала
   * сдвиг, потом возврат.
   */
  moveCorner(id: string, p: Vec3, opts: { history?: boolean } = {}): SolidFault | null {
    const obj = this.get(id);
    if (!obj || obj.kind !== 'point' || obj.corner === undefined) return null;
    const fit = reshapeSolid(SOLIDS[this.doc.solid], this.movedCorner(obj.corner, p));
    if (!fit.ok) return fit.fault;
    this.update(id, (o) => {
      if (o.kind === 'point') o.p = clone(p);
    }, opts);
    return null;
  }

  /** Вершины фигуры, где указанной подставлено новое положение. */
  private movedCorner(index: number, p: Vec3): Vec3[] {
    const out = this.corners();
    out[index] = clone(p);
    return out;
  }

  /**
   * Смена фигуры. Чертёж прежней фигуры не переносится: у другой фигуры другие
   * грани и рёбра, и тот же сегмент или плоскость потеряли бы смысл. Всё
   * меняется одним `commit`, иначе отмена вернула бы куб с точками
   * параллелепипеда.
   */
  setSolid(id: SolidId): void {
    if (id === this.doc.solid) return;
    this.commit((d) => {
      d.solid = id;
      d.objects = [];
      addCorners(d, SOLIDS[id]);
    });
    this.selection = [];
  }

  /** Удаляет объекты. Угловые точки фигуры защищены и остаются на месте. */
  remove(ids: string[]): void {
    this.commit((d) => {
      // Условие в filter описывает, что ОСТАЁТСЯ, поэтому удаляемые объекты
      // и защищённые углы здесь отбрасываются, а не наоборот.
      d.objects = d.objects.filter((o) => o.fixed || !ids.includes(o.id));
    });
    this.selection = this.selection.filter((s) => this.get(s));
  }

  /**
   * Есть ли на сцене что-то, кроме углов фигуры.
   *
   * Углы помечены `fixed` и переживают очистку, поэтому длина `objects` всегда
   * равна числу углов: по ней нельзя понять, есть ли что стирать.
   */
  hasContent(): boolean {
    return this.doc.objects.some((o) => !o.fixed);
  }

  /** Полная очистка сцены. Угловые точки фигуры остаются. */
  clear(): void {
    this.commit((d) => {
      d.objects = d.objects.filter((o) => o.fixed);
    });
    this.selection = [];
  }

  /**
   * Переименование объекта. Пустое имя возвращается к прежнему, иначе на
   * сцене осталась бы безымянная точка, которую нечем опознать в списке.
   *
   * Угол фигуры не переименовывается: его имя пришло из нотации фигуры и стоит в
   * подписи грани, поэтому точка P рядом с гранью DAA₁D₁ читалась бы как опечатка.
   */
  rename(id: string, name: string): void {
    const trimmed = name.trim();
    const obj = this.get(id);
    if (!obj || obj.fixed || !trimmed || trimmed === obj.name) return;
    this.update(id, (o) => {
      o.name = trimmed;
    });
  }

  get(id: string): SceneObj | undefined {
    return this.doc.objects.find((o) => o.id === id);
  }

  selected(): SceneObj[] {
    return this.doc.objects.filter((o) => this.selection.includes(o.id));
  }

  toggleSelect(id: string, additive: boolean): void {
    if (!additive) {
      this.selection = this.selection.length === 1 && this.selection[0] === id ? [] : [id];
    } else if (this.selection.includes(id)) {
      this.selection = this.selection.filter((s) => s !== id);
    } else {
      this.selection.push(id);
    }
    this.emit();
  }

  selectOnly(ids: string[]): void {
    this.selection = ids;
    this.emit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.doc));
    this.doc = prev;
    this.selection = this.selection.filter((s) => this.get(s));
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.doc));
    this.doc = next;
    this.selection = this.selection.filter((s) => this.get(s));
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
