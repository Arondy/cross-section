export const COLOR = {
  point: 0xffd166,
  line: 0x4cc9f0,
  segment: 0x7bd88f,
  plane: 0xffffff,
  // Точка, замыкающая цепочку плоскости. Держим её розовой, а не в цвете
  // плоскости: сечение белое, и отметка на нём была бы не видна.
  chainFirst: 0xf72585,
} as const;

// Отрезки зелёные: прямые и отрезки рисуются рядом, и по цвету их видно сразу,
// не читая подпись.
export const PALETTE = {
  line: [0x4cc9f0, 0x48cae4, 0x00b4d8, 0x90e0ef, 0x00bbf9, 0xcaf0f8],
  segment: [0x7bd88f, 0x95e1a8, 0x5ec97a, 0xa9e6b8, 0x74d68c, 0xb9ecc4],
  // Сечения белые, и вторая и третья плоскости отличаются от первой оттенком
  // серого: два одинаковых белых контура в сцене не различить.
  plane: [0xffffff, 0xdfe6ef, 0xc3cfdc, 0xa8b8c9, 0x8fa2b8, 0x7b8ea3],
} as const;

export const cssColor = (hex: number): string =>
  `#${hex.toString(16).padStart(6, '0')}`;
