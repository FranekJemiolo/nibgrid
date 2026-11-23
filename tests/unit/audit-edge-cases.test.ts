import { describe, expect, it } from 'vitest';
import { parseGplPalette, parseHexPalette } from '../../src/domain/palette';
import { defringeInteriorRgb } from '../../src/processing/alphaCleanup';
import { alignToSafeMargin, extractLinesAndContrast } from '../../src/processing/normalize';
import { quantizeToPaletteOklab } from '../../src/processing/paletteQuantize';
import {
  autoTrimTransparent,
  padToPowerOfTwo,
  resampleRgba,
} from '../../src/processing/resampleAndTrim';
import {
  injectComfyUiWorkflow,
  validateComfyUiWorkflowTemplate,
} from '../../src/providers/comfyuiWorkflows';
import { createMonotonicRequestGuard } from '../../src/workers/postprocessClient';

function expectAllBytesFinite(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i++) {
    const byte = rgba[i]!;
    expect(Number.isFinite(byte)).toBe(true);
    expect(byte).toBeGreaterThanOrEqual(0);
    expect(byte).toBeLessThanOrEqual(255);
  }
}

describe('Phase 2 Audit: Concurrency Guards, Parsers & Extreme Input Edge Cases', () => {
  it('discards stale worker tokens via createMonotonicRequestGuard', () => {
    const guard = createMonotonicRequestGuard();
    const first = guard.next();
    expect(guard.isCurrent(first)).toBe(true);

    const second = guard.next();
    expect(second).toBeGreaterThan(first);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });

  it('fuzzes palette parsers with CRLF, inline comments, duplicates, and malformed inputs', () => {
    const crlfHex =
      '// Header comment\r\n# leading comment\r\nff00aa\r\n  #112233 ; inline comment\r\nFF00AA // duplicate\r\n\r\n';
    expect(parseHexPalette(crlfHex)).toEqual(['#FF00AA', '#112233']);

    const crlfGpl =
      'GIMP Palette\r\nName: Fuzz\r\n# Comment\r\n  255\t0  128\tRose\r\n0 255 64 Lime\r\n255 0 128 Duplicate\r\n';
    expect(parseGplPalette(crlfGpl)).toEqual(['#FF0080', '#00FF40']);

    expect(() => parseHexPalette('#ZZZZZZ')).toThrow(/invalid hex/i);
    expect(() => parseGplPalette('Not a GIMP header\n255 0 0 Red')).toThrow(/header/i);
    expect(() => parseGplPalette('GIMP Palette\n256 0 0 Overflow')).toThrow(/out of range/i);
    expect(() => parseGplPalette('GIMP Palette\n-1 0 0 Negative')).toThrow(/invalid red/i);
  });

  it('rejects malformed ComfyUI workflow JSON and missing {{PROMPT}} tokens', () => {
    expect(() => validateComfyUiWorkflowTemplate('   ')).toThrow(/cannot be empty/i);
    expect(() => validateComfyUiWorkflowTemplate('{bad json')).toThrow(/valid JSON/i);
    expect(() => validateComfyUiWorkflowTemplate('[]')).toThrow(/JSON object/i);
    expect(() => validateComfyUiWorkflowTemplate('{}')).toThrow(/at least one node/i);
    expect(() => validateComfyUiWorkflowTemplate(JSON.stringify({ nodes: [], links: [] }))).toThrow(
      /node "nodes" must be a JSON object|missing a valid "class_type"/i,
    );
    expect(() =>
      validateComfyUiWorkflowTemplate(
        JSON.stringify({
          '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hardcoded prompt' } },
        }),
      ),
    ).toThrow(/\{\{PROMPT\}\}/);

    const validJson = JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{PROMPT}}', seed: '{{SEED}}' } },
    });
    const injected = injectComfyUiWorkflow({
      customTemplateJson: validJson,
      prompt: 'armored slime',
      negativePrompt: 'blur',
      seed: 777,
      adherence: 'strict',
      sketchFilename: 'sketch.png',
    });
    expect(injected.prompt['1']?.inputs.text).toBe('armored slime');
    expect(injected.prompt['1']?.inputs.seed).toBe(777);
  });

  it('handles 1x1 buffers (all-white, ink, and all-transparent) cleanly without NaN', () => {
    const white1x1 = new Uint8ClampedArray([255, 255, 255, 255]);
    const ink1x1 = new Uint8ClampedArray([10, 10, 10, 255]);
    const transparent1x1 = new Uint8ClampedArray([120, 40, 200, 0]);

    for (const buf of [white1x1, ink1x1, transparent1x1]) {
      const lines = extractLinesAndContrast(buf, 1, 1);
      expect(lines).toHaveLength(4);
      expectAllBytesFinite(lines);

      const aligned = alignToSafeMargin(lines, 1, 1, 16, 0.1, 16);
      expect(aligned).toHaveLength(16 * 16 * 4);
      expectAllBytesFinite(aligned);

      const defringed = defringeInteriorRgb(buf, 1, 1, 2);
      expect(defringed).toHaveLength(4);
      expectAllBytesFinite(defringed);

      const snappedEmpty = quantizeToPaletteOklab(buf, 1, 1, []);
      expect(Array.from(snappedEmpty)).toEqual(Array.from(buf));

      const snapped = quantizeToPaletteOklab(buf, 1, 1, ['#112233', '#DDEEFF']);
      expect(snapped[3]).toBe(buf[3]);
      expectAllBytesFinite(snapped);

      const areaResampled = resampleRgba(buf, 1, 1, 4, 4, 'area');
      expect(areaResampled.rgba).toHaveLength(4 * 4 * 4);
      expectAllBytesFinite(areaResampled.rgba);

      const trimmed = autoTrimTransparent(buf, 1, 1, 1);
      expect(trimmed.width).toBeGreaterThanOrEqual(1);
      expect(trimmed.height).toBeGreaterThanOrEqual(1);
      expectAllBytesFinite(trimmed.rgba);

      const pot = padToPowerOfTwo(trimmed.rgba, trimmed.width, trimmed.height, 'bottom');
      expect(pot.width & (pot.width - 1)).toBe(0);
      expect(pot.height & (pot.height - 1)).toBe(0);
    }

    expect(() => resampleRgba(white1x1, 1, 1, 0, 8, 'nearest')).toThrow(/Invalid resample/);
    expect(() => autoTrimTransparent(white1x1, 0, 1)).toThrow(/Invalid image/);
  });

  it('handles 3000x2000 extreme images cleanly without OOB or memory errors', () => {
    const width = 3000;
    const height = 2000;
    const large = new Uint8ClampedArray(width * height * 4);
    // Stamp a small opaque centered 4x4 sprite block surrounded by transparency
    for (let y = 998; y < 1002; y++) {
      for (let x = 1498; x < 1502; x++) {
        const px = (y * width + x) * 4;
        large[px] = 240;
        large[px + 1] = 60;
        large[px + 2] = 40;
        large[px + 3] = 255;
      }
    }

    const trimmed = autoTrimTransparent(large, width, height, 2);
    expect(trimmed.width).toBe(8);
    expect(trimmed.height).toBe(8);

    const downsampled = resampleRgba(large, width, height, 64, 64, 'area');
    expect(downsampled.rgba).toHaveLength(64 * 64 * 4);
    expectAllBytesFinite(downsampled.rgba);

    const lines = extractLinesAndContrast(downsampled.rgba, 64, 64);
    expect(lines).toHaveLength(64 * 64 * 4);
    expectAllBytesFinite(lines);
  });
});
