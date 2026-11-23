export interface RgbaBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray; // length === width * height * 4
}

export interface Rgb {
  readonly r: number; // 0..255
  readonly g: number; // 0..255
  readonly b: number; // 0..255
}

export interface Oklab {
  readonly L: number; // 0..1 perceived lightness
  readonly a: number; // green (-) to red (+)
  readonly b: number; // blue (-) to yellow (+)
}

export type LightDirection = 'top-left' | 'top-right' | 'overhead' | 'flat';
