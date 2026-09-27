/**
 * Значки панели нарисованы здесь, а не вставляются эмодзи: эмодзи-глаз рисуется
 * на каждой системе по-своему, а в тёмной панели выбивается из ряда.
 */
const wrap = (body: string): string =>
  `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

export const ICON_EYE = wrap(
  '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" />'
);

export const ICON_CROSS = wrap('<path d="M4 4l8 8M12 4l-8 8" />');
