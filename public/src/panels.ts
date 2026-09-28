/**
 * Отрисовка панелей: список объектов, свойства выбранного и состояние рейки.
 *
 * Панель только показывает документ и отправляет правки обратно в `Store`.
 * Правил построения здесь нет: что можно построить и как оно называется,
 * решают `targets`, а не вёрстка списка.
 */
import {
  dist,
  faceOf,
  fmt,
  planeEdgePoints,
  sectionPolygon,
  v3,
  type SolidFault,
  type TrimEnd,
  type Vec3,
} from './geometry';
import { makePoint, type LineObj, type PointObj, type SceneObj } from './model';
import { solidFaultHint, solidGen } from './hints';
import { ICON_CROSS, ICON_EYE } from './icons';
import { $, flash, state, store } from './app';
import { autoTrimAtCrossings, clearTrimEnd } from './targets';

export function updateToolbar(): void {
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

export function renderObjectList(): void {
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

/** Правка положения обычной точки. Фигура от неё не зависит, отказа не бывает. */
function movePoint(id: string, p: Vec3): SolidFault | null {
  store.update(id, (o) => {
    if (o.kind === 'point') o.p = p;
  });
  return null;
}

export function renderProperties(): void {
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
      // Координаты угла меняют саму фигуру, поэтому идут через `moveCorner`:
      // свойства не должны быть путём, где проверки фигуры нет.
      card.append(
        vecInputs(obj.fixed ? 'Положение угла' : 'Координаты', obj.p, (p) => {
          const fault = obj.fixed
            ? store.moveCorner(obj.id, p)
            : movePoint(obj.id, p);
          if (fault) {
            // Отказ возвращает полю прежнее число: иначе введённое значение
            // осталось бы стоять в поле, хотя на сцене угол не сдвинулся.
            flash(solidFaultHint(fault));
            renderProperties();
          }
        })
      );
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
  // Угол фигуры не переименовать: имя пришло из нотации и стоит в подписи грани.
  // Иначе человек вводил бы имя, а оно молча не сохранялось бы.
  if (obj.fixed) return readout('Имя угла', obj.name);
  l.textContent = 'Имя';
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
