/**
 * Точка входа: перерисовка по документу, рейка инструментов, кнопки, клавиши и
 * демо-заготовка.
 *
 * Правил построения здесь нет - они в `targets`, мышь в `pointer`, вёрстка в
 * `panels`. Отсюда видно только, что происходит в приложении целиком: какая
 * сцена собрана, какой инструмент выбран и что нажали.
 */
import * as THREE from 'three';
import { faceOf, norm, sectionPolygon, v3, type Plane, type SolidId, type Vec3 } from './geometry';
import { addCorners, makePlane, makePoint, type Tool } from './model';
import { DEMO, SOLIDS_UI, TOOLS_UI, solidGen } from './hints';
import { HELP_TOOLS, HELP_VIEW } from './help';
import { SOLID_ICONS, TOOL_ICONS } from './icons';
import { buildPendingOverlay, buildScene } from './objects3d';
import { $, flash, state, store, syncPending, viewer } from './app';
import { isChainMode, updateHover } from './targets';
import { bindPointer } from './pointer';
import { renderObjectList, renderProperties, updateToolbar } from './panels';

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

function refresh(): void {
  // Фигура могла смениться и отменой, поэтому сцена приводится к ней здесь, а
  // не только в обработчике кнопки: иначе Ctrl+Z вернул бы куб с точками
  // тетраэдра.
  viewer.setSolid(store.solid);
  viewer.setObjectGroup(buildScene(store.solid, store.doc, store.selection));
  viewer.setOverlay(
    buildPendingOverlay(
      state.pending.map((pt) => pt.p),
      isChainMode()
    )
  );
  // setOverlay пересобирает группу, поэтому превью приходится применять заново.
  updateHover();
  renderObjectList();
  renderProperties();
  ($('#undo') as HTMLButtonElement).disabled = !store.canUndo;
  ($('#redo') as HTMLButtonElement).disabled = !store.canRedo;
  viewer.requestRender();
}

function setTool(tool: Tool): void {
  state.tool = tool;
  state.pending = [];
  // Выбор сбрасывается вместе с инструментом: поднятая точка принадлежит
  // инструменту «Выбор», и в панели свойств она оставалась бы жить при
  // «Отсечении» или «Плоскости», где клик по ней значит совсем другое.
  store.selectOnly([]);
  syncPending();
  updateToolbar();
  updateHover();
  refresh();
}

/**
 * Справка собирается из `help.ts`, а не живёт в разметке: текст должен
 * лежать рядом с остальными строками интерфейса и проверяться одним взглядом.
 */
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

bindPointer(refresh);

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
(window as unknown as Record<string, unknown>).__THREE = THREE;
refresh();
viewer.start();
