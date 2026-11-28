export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface FrameAnchorMetrics {
  readonly empty: boolean;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

export interface StabilizedStripResult {
  readonly frames: readonly RgbaFrame[];
  readonly baselineBottomY: number;
  readonly targetAnchorX: number;
  readonly shifts: readonly { readonly dx: number; readonly dy: number }[];
}

/**
 * Measures tight opaque bounds and the horizontal center-of-mass of the bottom 20% foot band
 * (`anchor === 'bottom-center'`) or full bounding box center (`anchor === 'center'`).
 */
export function measureFrameAnchor(
  frame: RgbaFrame,
  anchor: 'bottom-center' | 'center' = 'bottom-center',
): FrameAnchorMetrics {
  const { width, height, data } = frame;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      empty: true,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      anchorX: Math.floor(width / 2),
      anchorY: height - 1,
    };
  }

  const bboxHeight = maxY - minY + 1;
  const footBandHeight = Math.max(1, Math.floor(bboxHeight * 0.2));
  const sliceTop = anchor === 'bottom-center' ? Math.max(minY, maxY - footBandHeight + 1) : minY;

  let sumX = 0;
  let count = 0;
  for (let y = sliceTop; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        sumX += x;
        count++;
      }
    }
  }

  const anchorX = count > 0 ? Math.round(sumX / count) : Math.round((minX + maxX) / 2);
  const anchorY = anchor === 'bottom-center' ? maxY : Math.round((minY + maxY) / 2);

  return { empty: false, minX, maxX, minY, maxY, anchorX, anchorY };
}

function translateFrame(frame: RgbaFrame, dx: number, dy: number): RgbaFrame {
  const out = new Uint8ClampedArray(frame.data.length);
  const { width, height, data } = frame;

  for (let y = 0; y < height; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let x = 0; x < width; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const si = (y * width + x) * 4;
      if ((data[si + 3] ?? 0) === 0) continue;
      const di = (ny * width + nx) * 4;
      out[di] = data[si] ?? 0;
      out[di + 1] = data[si + 1] ?? 0;
      out[di + 2] = data[si + 2] ?? 0;
      out[di + 3] = data[si + 3] ?? 0;
    }
  }

  return { width, height, data: out };
}

/**
 * Aligns all non-empty animation frames to an identical baseline (`bottomY` when `bottom-center`,
 * or center pivot when `center`) via integer pixel translations clamped against canvas edge clipping.
 */
export function stabilizeAnimationStripDetailed(
  frames: readonly RgbaFrame[],
  anchor: 'bottom-center' | 'center' = 'bottom-center',
): StabilizedStripResult {
  if (frames.length === 0) {
    return { frames: [], baselineBottomY: 0, targetAnchorX: 0, shifts: [] };
  }

  const refWidth = frames[0]!.width;
  const refHeight = frames[0]!.height;
  const metrics = frames.map((f) => measureFrameAnchor(f, anchor));
  const nonEmpty = metrics.filter((m) => !m.empty);

  if (nonEmpty.length === 0) {
    return {
      frames: frames.map((f) => ({
        width: f.width,
        height: f.height,
        data: new Uint8ClampedArray(f.data),
      })),
      baselineBottomY: refHeight - 1,
      targetAnchorX: Math.floor(refWidth / 2),
      shifts: frames.map(() => ({ dx: 0, dy: 0 })),
    };
  }

  const maxSpriteHeight = nonEmpty.reduce((best, m) => Math.max(best, m.maxY - m.minY + 1), 1);
  const sortedAnchorsY = [...nonEmpty].map((m) => m.anchorY).sort((a, b) => a - b);
  const medianAnchorY = sortedAnchorsY[Math.floor(sortedAnchorsY.length / 2)] ?? refHeight - 1;

  const targetAnchorY =
    anchor === 'bottom-center'
      ? Math.max(maxSpriteHeight - 1, Math.min(refHeight - 1, medianAnchorY))
      : Math.floor(refHeight / 2);
  const targetAnchorX = Math.floor(refWidth / 2);

  const shifts: { dx: number; dy: number }[] = [];
  const stabilized = frames.map((frame, i) => {
    const m = metrics[i]!;
    if (m.empty) {
      shifts.push({ dx: 0, dy: 0 });
      return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
    }
    const rawDx = targetAnchorX - m.anchorX;
    const rawDy = targetAnchorY - m.anchorY;
    const dx = Math.max(-m.minX, Math.min(frame.width - 1 - m.maxX, rawDx));
    const dy = Math.max(-m.minY, Math.min(frame.height - 1 - m.maxY, rawDy));
    shifts.push({ dx, dy });
    return translateFrame(frame, dx, dy);
  });

  return {
    frames: stabilized,
    baselineBottomY: targetAnchorY,
    targetAnchorX,
    shifts,
  };
}

/**
 * Convenience wrapper returning the stabilized `RgbaFrame[]` aligned to the shared foot anchor.
 */
export function stabilizeAnimationStrip(
  frames: readonly RgbaFrame[],
  anchor: 'bottom-center' | 'center' = 'bottom-center',
): RgbaFrame[] {
  return [...stabilizeAnimationStripDetailed(frames, anchor).frames];
}
