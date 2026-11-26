import { describe, expect, it } from 'vitest';
import { createPoseClipFromPreset } from '../../src/processing/posePresets';
import {
  ALL_POSE_JOINT_IDS,
  applyJointDragWithIk,
  interpolatePoseFrames,
  renderOpenPoseStrip,
  sliceAndAlignPoseStrip,
  solveTwoBoneIk,
} from '../../src/processing/poseRigCore';
import type { RgbaBuffer } from '../../src/processing/types';

describe('M34A Pure-TS 15-Joint Pose Rig, Analytic 2-Bone IK & OpenPose Renderer', () => {
  it('solveTwoBoneIk preserves exact bone lengths with zero NaN for bent & overstretched targets', () => {
    const root = { x: 0.45, y: 0.35 };
    const lenA = 0.16;
    const lenB = 0.14;

    const bent = solveTwoBoneIk(root, { x: 0.56, y: 0.48 }, lenA, lenB, 1);
    const d1 = Math.hypot(bent.mid.x - root.x, bent.mid.y - root.y);
    const d2 = Math.hypot(bent.end.x - bent.mid.x, bent.end.y - bent.mid.y);
    expect(Number.isFinite(d1) && Number.isFinite(d2)).toBe(true);
    expect(Math.abs(d1 - lenA)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(d2 - lenB)).toBeLessThanOrEqual(1e-4);

    // Over-stretched target beyond lenA + lenB
    const stretched = solveTwoBoneIk(root, { x: 2.0, y: 2.0 }, lenA, lenB, -1);
    const sd1 = Math.hypot(stretched.mid.x - root.x, stretched.mid.y - root.y);
    const sd2 = Math.hypot(stretched.end.x - stretched.mid.x, stretched.end.y - stretched.mid.y);
    expect(Number.isFinite(sd1) && Number.isFinite(sd2)).toBe(true);
    expect(Math.abs(sd1 - lenA)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(sd2 - lenB)).toBeLessThanOrEqual(1e-4);

    // Degenerate zero-distance target at root
    const zeroTarget = solveTwoBoneIk(root, root, lenA, lenB, 1);
    expect(Number.isNaN(zeroTarget.mid.x)).toBe(false);
    expect(Number.isNaN(zeroTarget.end.y)).toBe(false);
  });

  it('interpolatePoseFrames(a, b, 0.5) computes exact midpoints for all 15 joints', () => {
    const runClip = createPoseClipFromPreset('run_6f', 64, 64);
    const a = runClip.frames[0]!;
    const b = runClip.frames[3]!;
    const mid = interpolatePoseFrames(a, b, 0.5, 'mid-run');

    expect(mid.id).toBe('mid-run');
    for (const jointId of ALL_POSE_JOINT_IDS) {
      expect(mid.joints[jointId].x).toBeCloseTo((a.joints[jointId].x + b.joints[jointId].x) / 2, 6);
      expect(mid.joints[jointId].y).toBeCloseTo((a.joints[jointId].y + b.joints[jointId].y) / 2, 6);
    }

    const modified = applyJointDragWithIk(
      a.joints,
      'r_wrist',
      { x: 0.28, y: 0.36 },
      { useIk: true, mirrorLimbs: false },
    );
    expect(modified.r_wrist).not.toEqual(a.joints.r_wrist);
  });

  it('renderOpenPoseStrip renders 384x64 OpenPose guide strip with distinct L/R RGB channels on #000000', () => {
    const runClip = createPoseClipFromPreset('run_6f', 64, 64);
    const strip = renderOpenPoseStrip(runClip.frames, 64, 64);

    expect(strip.width).toBe(384);
    expect(strip.height).toBe(64);
    // Corner background pixel (0,0) must be solid #000000
    expect([strip.data[0], strip.data[1], strip.data[2], strip.data[3]]).toEqual([0, 0, 0, 255]);

    // Check distinct OpenPose color channels for right arm (orange/yellow) vs left arm (green/lime)
    let sawRightArmOrange = false;
    let sawLeftArmGreen = false;
    let sawLeftLegMagenta = false;
    for (let i = 0; i < strip.data.length; i += 4) {
      const r = strip.data[i]!;
      const g = strip.data[i + 1]!;
      const b = strip.data[i + 2]!;
      if (r === 255 && g >= 170 && b === 0) sawRightArmOrange = true;
      if (r <= 85 && g === 255 && b <= 85) sawLeftArmGreen = true;
      if (r >= 170 && g === 0 && b === 255) sawLeftLegMagenta = true;
    }
    expect(sawRightArmOrange).toBe(true);
    expect(sawLeftArmGreen).toBe(true);
    expect(sawLeftLegMagenta).toBe(true);
  });

  it('sliceAndAlignPoseStrip strips #FF00FF chroma and aligns bottom opaque row across all 6 frames', () => {
    const fw = 64;
    const fh = 64;
    const frameCount = 6;
    const strip: RgbaBuffer = {
      width: fw * frameCount,
      height: fh,
      data: new Uint8ClampedArray(fw * frameCount * fh * 4),
    };
    // Fill with solid #FF00FF chroma key background
    for (let i = 0; i < strip.data.length; i += 4) {
      strip.data[i] = 255;
      strip.data[i + 1] = 0;
      strip.data[i + 2] = 255;
      strip.data[i + 3] = 255;
    }
    // Paint synthetic sprites at deliberately varying vertical bottom positions per cell
    for (let f = 0; f < frameCount; f++) {
      const bottomY = 44 + (f % 4) * 4;
      for (let y = bottomY - 18; y <= bottomY; y++) {
        for (let x = f * fw + 24; x < f * fw + 40; x++) {
          const idx = (y * strip.width + x) * 4;
          strip.data[idx] = 255;
          strip.data[idx + 1] = 205;
          strip.data[idx + 2] = 117;
          strip.data[idx + 3] = 255;
        }
      }
    }

    const frames = sliceAndAlignPoseStrip(strip, frameCount, [255, 0, 255], {
      groundMarginPx: 2,
    });
    expect(frames.length).toBe(6);

    const bottoms: number[] = [];
    for (const frame of frames) {
      expect(frame.width).toBe(64);
      expect(frame.height).toBe(64);
      // Chroma pixel at corner must now be transparent
      expect(frame.data[3]).toBe(0);
      let maxY = -1;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if ((frame.data[(y * frame.width + x) * 4 + 3] ?? 0) > 0) {
            maxY = y;
          }
        }
      }
      bottoms.push(maxY);
    }
    // All 6 frames must share the exact aligned ground row y = 61
    expect(bottoms).toEqual([61, 61, 61, 61, 61, 61]);
  });
});
