import { describe, expect, it } from 'vitest';
import {
  ANIM_PRESETS,
  evaluatePresetPins,
  type AnimPresetKind,
  type PuppetPin,
} from '../../src/processing/animPresets';
import { solveMlsMesh, type Vec2 } from '../../src/processing/mlsWarp';
import { buildAlphaClippedMesh } from '../../src/processing/spriteMesh';

const SAMPLE_PINS: readonly Vec2[] = [
  { x: 12, y: 52 },
  { x: 52, y: 52 },
  { x: 32, y: 34 },
  { x: 24, y: 18 },
  { x: 40, y: 18 },
];

function makeTestMeshVertices(): Float32Array {
  const verts: number[] = [];
  // Include vertices intentionally coinciding with SAMPLE_PINS as well as regular grid nodes
  for (const p of SAMPLE_PINS) {
    verts.push(p.x, p.y);
  }
  for (let y = 16; y <= 48; y += 8) {
    for (let x = 16; x <= 48; x += 8) {
      verts.push(x, y);
    }
  }
  return new Float32Array(verts);
}

describe('M9 MLS Puppet-Warp Solver & Cyclic Presets', () => {
  it('satisfies identity invariance (deformedPins === restPins => zero error and zero rotations)', () => {
    const restVerts = makeTestMeshVertices();
    const res = solveMlsMesh(restVerts, SAMPLE_PINS, SAMPLE_PINS, 'rigid');

    let maxErr = 0;
    for (let i = 0; i < restVerts.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((res.positions[i] ?? 0) - (restVerts[i] ?? 0)));
    }
    expect(maxErr).toBeLessThan(1e-6);
    for (let i = 0; i < res.rotations.length; i++) {
      expect(Math.abs(res.rotations[i] ?? 1)).toBeLessThan(1e-6);
    }
  });

  it('maps vertices coinciding with control pins exactly to deformed pin targets with zero NaN', () => {
    const restVerts = makeTestMeshVertices();
    const deformed: Vec2[] = [
      { x: 12, y: 52 },
      { x: 52, y: 52 },
      { x: 36, y: 31 },
      { x: 27, y: 14 },
      { x: 43, y: 16 },
    ];
    const res = solveMlsMesh(restVerts, SAMPLE_PINS, deformed, 'rigid');

    for (let k = 0; k < SAMPLE_PINS.length; k++) {
      expect(Number.isFinite(res.positions[k * 2])).toBe(true);
      expect(Number.isFinite(res.positions[k * 2 + 1])).toBe(true);
      expect(res.positions[k * 2]).toBeCloseTo(deformed[k]!.x, 5);
      expect(res.positions[k * 2 + 1]).toBeCloseTo(deformed[k]!.y, 5);
    }
  });

  it('preserves pairwise edge lengths under rigid 90-degree rotation and computes PI/2 vertex angles', () => {
    const restVerts = makeTestMeshVertices();
    const cx = 32;
    const cy = 32;
    const rotatedPins: Vec2[] = SAMPLE_PINS.map((p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      // +90 degree rotation in 2D Euclidean coords: (x', y') = (-dy, +dx)
      return { x: cx - dy, y: cy + dx };
    });

    const res = solveMlsMesh(restVerts, SAMPLE_PINS, rotatedPins, 'rigid');
    const vCount = restVerts.length / 2;

    for (let a = 0; a < vCount; a++) {
      expect(res.rotations[a]).toBeCloseTo(Math.PI / 2, 4);
      for (let b = a + 1; b < vCount; b++) {
        const restDist = Math.hypot(
          (restVerts[a * 2] ?? 0) - (restVerts[b * 2] ?? 0),
          (restVerts[a * 2 + 1] ?? 0) - (restVerts[b * 2 + 1] ?? 0),
        );
        const defDist = Math.hypot(
          (res.positions[a * 2] ?? 0) - (res.positions[b * 2] ?? 0),
          (res.positions[a * 2 + 1] ?? 0) - (res.positions[b * 2 + 1] ?? 0),
        );
        expect(Math.abs(defDist - restDist)).toBeLessThan(1e-4);
      }
    }
  });

  it('evaluates periodic loop closure identically at t=0 and t=1 across all animation presets', () => {
    const puppetPins: readonly PuppetPin[] = [
      { id: 'p1', x: 32, y: 56, role: 'anchor' },
      { id: 'p2', x: 32, y: 34, role: 'driver' },
      { id: 'p3', x: 32, y: 14, role: 'tip' },
    ];
    const presetNames = Object.keys(ANIM_PRESETS) as AnimPresetKind[];

    for (const preset of presetNames) {
      const at0 = evaluatePresetPins(puppetPins, preset, 0);
      const at1 = evaluatePresetPins(puppetPins, preset, 1);
      for (let i = 0; i < puppetPins.length; i++) {
        expect(Math.hypot(at0[i]!.x - at1[i]!.x, at0[i]!.y - at1[i]!.y)).toBeLessThan(1e-6);
      }
    }

    // Also verify alpha-clipped mesh builder drops outer transparent quads
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 24; y < 40; y++) {
      for (let x = 24; x < 40; x++) {
        data[(y * 64 + x) * 4 + 3] = 255;
      }
    }
    const mesh = buildAlphaClippedMesh({ width: 64, height: 64, data }, { cellPx: 4 });
    expect(mesh.quadCount).toBeLessThan(16 * 16);
    expect(mesh.quadCount).toBeGreaterThan(0);
  });
});
