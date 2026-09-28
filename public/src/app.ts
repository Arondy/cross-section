/**
 * Общее состояние приложения: сцена, документ, выбранный инструмент и ввод.
 *
 * Модуль лежит ниже остальных и ничего не знает про цели, мышь и панели, поэтому
 * его можно импортировать отовсюду, не замыкая кольцо зависимостей.
 */
import { fmt, type Vec3 } from './geometry';
import { Store, type Tool } from './model';
import { Viewer } from './viewer';

export const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export const canvas = $<HTMLCanvasElement>('#view');
export const store = new Store();
export const viewer = new Viewer(canvas);

/** Точка ввода: координаты плюс имя, чтобы ошибки называли конкретные точки. */
export type PendingPoint = { p: Vec3; name: string };

export type ToolState = {
  tool: Tool;
  pending: PendingPoint[];
  snapEnabled: boolean;
  chainEnabled: boolean;
  stickRadius: number;
  drag: null | { id: string; part: string; moved: boolean; refused: boolean };
  hoverInfo: string;
};

export const state: ToolState = {
  tool: 'select',
  pending: [],
  snapEnabled: true,
  chainEnabled: true,
  stickRadius: 0.25,
  drag: null,
  hoverInfo: '',
};

export function flash(message: string): void {
  const el = $('#flash');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
let flashTimer: ReturnType<typeof setTimeout>;

/**
 * Точки ввода в статусной строке. Каждая вводная точка показывается фишкой, а
 * не общей строкой: их число видно сразу, и порядок ввода сохраняется.
 *
 * Постоянной подсказки рядом нет, поэтому строка появляется только когда есть
 * что показать, и не занимает место впустую.
 */
export function syncPending(): void {
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
// __END__
