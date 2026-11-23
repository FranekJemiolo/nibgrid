import type { ArtMode, Projection } from '../../domain/schemas';
import {
  generateBiomeTile,
  generateParallaxLayers,
  type BiomeId,
} from '../../processing/sandboxBiomes';
import { computeBiomeContrast, type BiomeContrastReport } from '../../processing/sandboxContrast';
import {
  createInitialSandboxState,
  stepSandboxState,
  toggleFlip,
  triggerHit,
  type FlashColorMode,
  type SandboxGridSize,
  type SandboxInputState,
  type SandboxLens,
  type SandboxScale,
  type SandboxState,
} from '../../processing/sandboxState';
import type { RgbaBuffer } from '../../processing/types';

export interface SandboxCameraPreset {
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

export const SANDBOX_CAMERA_PRESETS: readonly SandboxCameraPreset[] = [
  { width: 320, height: 180, label: '320×180 (GBA / Pixel Indie)' },
  { width: 480, height: 270, label: '480×270 (16-Bit Widescreen)' },
  { width: 640, height: 360, label: '640×360 (HD-2D Stage)' },
];

export interface SandboxEngineConfig {
  readonly biomeId: BiomeId;
  readonly projection: Projection;
  readonly artMode: ArtMode;
  readonly cameraWidth: number;
  readonly cameraHeight: number;
  readonly scale: SandboxScale;
  readonly lens: SandboxLens;
  readonly flashColor: FlashColorMode;
  readonly scrollSpeedPxPerSec: number;
  readonly biomeDimmer: number;
  readonly gridSize: SandboxGridSize;
  readonly playing: boolean;
  readonly fps: number;
  readonly pingPong: boolean;
  readonly pivotNorm: { readonly x: number; readonly y: number };
}

interface PrebakedFrame {
  readonly colorCanvas: HTMLCanvasElement;
  readonly flashCanvas: HTMLCanvasElement;
  readonly darkSilhouetteCanvas: HTMLCanvasElement;
  readonly lightSilhouetteCanvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
}

function rgbaToScratchCanvas(buf: RgbaBuffer): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = buf.width;
  canvas.height = buf.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  }
  return canvas;
}

function bakeMaskTintCanvas(srcCanvas: HTMLCanvasElement, hexColor: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = hexColor;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
  }
  return c;
}

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Zero-allocation Canvas2D 60 FPS virtual-camera sandbox engine.
 * Allocates zero WebGL/WebGL2 contexts and performs zero per-frame canvas allocations.
 */
export class SandboxEngine {
  private readonly displayCanvas: HTMLCanvasElement;
  private readonly displayCtx: CanvasRenderingContext2D | null;
  private readonly virtualCanvas: HTMLCanvasElement;
  private readonly virtualCtx: CanvasRenderingContext2D | null;

  private config: SandboxEngineConfig;
  private state: SandboxState;
  private readonly activeKeys = new Set<string>();

  private biomeTileBuffer: RgbaBuffer;
  private biomeTileCanvas: HTMLCanvasElement | null = null;
  private biomePattern: CanvasPattern | null = null;
  private parallaxFarCanvas: HTMLCanvasElement | null = null;
  private parallaxFarPattern: CanvasPattern | null = null;
  private parallaxMidCanvas: HTMLCanvasElement | null = null;
  private parallaxMidPattern: CanvasPattern | null = null;

  private rawFrames: readonly RgbaBuffer[] = [];
  private frameBank: PrebakedFrame[] = [];
  private contrastReport: BiomeContrastReport;

  private rafId: number | null = null;
  private lastTimestampMs: number | null = null;
  private disposed = false;
  private ticks = 0;
  private readonly onContrastUpdate?: (report: BiomeContrastReport) => void;
  private readonly handleVisibilityBound: () => void;

  constructor(
    displayCanvas: HTMLCanvasElement,
    initialConfig: SandboxEngineConfig,
    initialFrames: readonly RgbaBuffer[],
    onContrastUpdate?: (report: BiomeContrastReport) => void,
  ) {
    this.displayCanvas = displayCanvas;
    this.displayCtx = displayCanvas.getContext('2d');
    this.virtualCanvas = document.createElement('canvas');
    this.virtualCanvas.width = initialConfig.cameraWidth;
    this.virtualCanvas.height = initialConfig.cameraHeight;
    this.virtualCtx = this.virtualCanvas.getContext('2d');

    this.config = initialConfig;
    this.onContrastUpdate = onContrastUpdate;
    this.state = createInitialSandboxState({
      posX: Math.round(initialConfig.cameraWidth * 0.5),
      posY: Math.round(initialConfig.cameraHeight * 0.68),
    });

    this.biomeTileBuffer = generateBiomeTile(initialConfig.biomeId, 64);
    this.rebuildBiomeResources(initialConfig.biomeId);
    this.rebuildFrameBank(initialFrames, initialConfig.flashColor);
    this.contrastReport = computeBiomeContrast(
      this.rawFrames[0] ?? { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      this.biomeTileBuffer,
    );
    this.onContrastUpdate?.(this.contrastReport);

    this.syncDisplayDimensions();
    this.handleVisibilityBound = () => {
      if (this.disposed) return;
      if (document.hidden) {
        this.stopLoop();
      } else {
        this.lastTimestampMs = null;
        this.startLoop();
      }
    };
    document.addEventListener('visibilitychange', this.handleVisibilityBound);

    this.renderFrame();
    if (!document.hidden) {
      this.startLoop();
    }
  }

  private syncDisplayDimensions(): void {
    const targetW = this.config.cameraWidth * this.config.scale;
    const targetH = this.config.cameraHeight * this.config.scale;
    if (this.virtualCanvas.width !== this.config.cameraWidth) {
      this.virtualCanvas.width = this.config.cameraWidth;
    }
    if (this.virtualCanvas.height !== this.config.cameraHeight) {
      this.virtualCanvas.height = this.config.cameraHeight;
    }
    if (this.displayCanvas.width !== targetW) {
      this.displayCanvas.width = targetW;
    }
    if (this.displayCanvas.height !== targetH) {
      this.displayCanvas.height = targetH;
    }
  }

  private releaseBiomeCanvases(): void {
    releaseCanvas(this.biomeTileCanvas);
    releaseCanvas(this.parallaxFarCanvas);
    releaseCanvas(this.parallaxMidCanvas);
    this.biomeTileCanvas = null;
    this.parallaxFarCanvas = null;
    this.parallaxMidCanvas = null;
    this.biomePattern = null;
    this.parallaxFarPattern = null;
    this.parallaxMidPattern = null;
  }

  private rebuildBiomeResources(biomeId: BiomeId): void {
    this.releaseBiomeCanvases();
    const layers = generateParallaxLayers(biomeId, 64);
    this.biomeTileBuffer = layers.ground;

    this.biomeTileCanvas = rgbaToScratchCanvas(layers.ground);
    this.parallaxFarCanvas = rgbaToScratchCanvas(layers.far);
    this.parallaxMidCanvas = rgbaToScratchCanvas(layers.mid);

    if (this.virtualCtx) {
      this.biomePattern = this.virtualCtx.createPattern(this.biomeTileCanvas, 'repeat');
      this.parallaxFarPattern = this.virtualCtx.createPattern(this.parallaxFarCanvas, 'repeat');
      this.parallaxMidPattern = this.virtualCtx.createPattern(this.parallaxMidCanvas, 'repeat');
    }
  }

  private releaseFrameBank(): void {
    for (const f of this.frameBank) {
      releaseCanvas(f.colorCanvas);
      releaseCanvas(f.flashCanvas);
      releaseCanvas(f.darkSilhouetteCanvas);
      releaseCanvas(f.lightSilhouetteCanvas);
    }
    this.frameBank = [];
  }

  private rebuildFrameBank(frames: readonly RgbaBuffer[], flashColor: FlashColorMode): void {
    this.releaseFrameBank();
    this.rawFrames = frames;
    const flashHex = flashColor === 'red' ? '#FF2A44' : '#FFFFFF';
    this.frameBank = frames.map((buf) => {
      const colorCanvas = rgbaToScratchCanvas(buf);
      return {
        colorCanvas,
        flashCanvas: bakeMaskTintCanvas(colorCanvas, flashHex),
        darkSilhouetteCanvas: bakeMaskTintCanvas(colorCanvas, '#05070B'),
        lightSilhouetteCanvas: bakeMaskTintCanvas(colorCanvas, '#FFFFFF'),
        width: buf.width,
        height: buf.height,
      };
    });
  }

  public updateConfig(nextConfig: SandboxEngineConfig): void {
    if (this.disposed) return;
    const biomeChanged = nextConfig.biomeId !== this.config.biomeId;
    const flashChanged = nextConfig.flashColor !== this.config.flashColor;
    const cameraChanged =
      nextConfig.cameraWidth !== this.config.cameraWidth ||
      nextConfig.cameraHeight !== this.config.cameraHeight ||
      nextConfig.scale !== this.config.scale;

    this.config = nextConfig;

    if (cameraChanged) {
      this.syncDisplayDimensions();
      this.state = {
        ...this.state,
        posX: Math.min(nextConfig.cameraWidth - 20, Math.max(20, this.state.posX)),
        posY: Math.min(nextConfig.cameraHeight - 12, Math.max(24, this.state.posY)),
      };
    }

    if (biomeChanged) {
      this.rebuildBiomeResources(nextConfig.biomeId);
      this.recomputeContrast();
    }

    if (flashChanged) {
      this.rebuildFrameBank(this.rawFrames, nextConfig.flashColor);
    }

    this.renderFrame();
  }

  public updateFrames(frames: readonly RgbaBuffer[]): void {
    if (this.disposed) return;
    this.rebuildFrameBank(frames, this.config.flashColor);
    this.state = {
      ...this.state,
      frameIndex: frames.length > 0 ? this.state.frameIndex % frames.length : 0,
    };
    this.recomputeContrast();
    this.renderFrame();
  }

  private recomputeContrast(): void {
    const first = this.rawFrames[0];
    if (!first) return;
    this.contrastReport = computeBiomeContrast(first, this.biomeTileBuffer);
    this.onContrastUpdate?.(this.contrastReport);
  }

  public setKeyPressed(key: string, down: boolean): void {
    const normalized = key.toLowerCase();
    if (down) {
      this.activeKeys.add(normalized);
    } else {
      this.activeKeys.delete(normalized);
    }
  }

  public triggerHit(): void {
    if (this.disposed) return;
    this.state = triggerHit(this.state);
    this.renderFrame();
  }

  public toggleFlip(): void {
    if (this.disposed) return;
    this.state = toggleFlip(this.state);
    this.renderFrame();
  }

  public getState(): SandboxState {
    return this.state;
  }

  private startLoop(): void {
    if (this.disposed || this.rafId !== null) return;
    this.displayCanvas.dataset.rafActive = 'true';
    const loop = (ts: number) => {
      if (this.disposed || document.hidden) {
        this.rafId = null;
        return;
      }
      const dt = this.lastTimestampMs === null ? 16.67 : ts - this.lastTimestampMs;
      this.lastTimestampMs = ts;

      const moveX =
        (this.activeKeys.has('d') || this.activeKeys.has('arrowright') ? 1 : 0) -
        (this.activeKeys.has('a') || this.activeKeys.has('arrowleft') ? 1 : 0);
      const moveY =
        (this.activeKeys.has('s') || this.activeKeys.has('arrowdown') ? 1 : 0) -
        (this.activeKeys.has('w') || this.activeKeys.has('arrowup') ? 1 : 0);

      const stepInput: SandboxInputState = {
        moveX,
        moveY,
        moveSpeedPxPerSec: 96,
        scrollSpeedPxPerSec: this.config.scrollSpeedPxPerSec,
        cameraWidth: this.config.cameraWidth,
        cameraHeight: this.config.cameraHeight,
        playing: this.config.playing,
        fps: this.config.fps,
        frameCount: this.frameBank.length,
        pingPong: this.config.pingPong,
      };

      this.state = stepSandboxState(this.state, stepInput, dt);
      this.renderFrame();
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.displayCanvas.dataset.rafActive = 'false';
  }

  private renderFrame(): void {
    const vCtx = this.virtualCtx;
    const dCtx = this.displayCtx;
    if (!vCtx || !dCtx) return;

    const camW = this.config.cameraWidth;
    const camH = this.config.cameraHeight;
    const pixelArt = this.config.artMode === 'pixel-art';
    vCtx.imageSmoothingEnabled = !pixelArt;
    vCtx.clearRect(0, 0, camW, camH);

    // 1. Projection-aware tiled biome background
    const sx = Math.round(this.state.scrollOffsetX);
    const sy = Math.round(this.state.scrollOffsetY);

    if (this.config.projection === 'side-scroller') {
      const horizonY = Math.round(camH * 0.68);
      if (this.parallaxFarPattern) {
        const oxFar = ((Math.round(sx * 0.2) % 64) + 64) % 64;
        vCtx.save();
        vCtx.translate(-oxFar, 0);
        vCtx.fillStyle = this.parallaxFarPattern;
        vCtx.fillRect(oxFar, 0, camW + 64, horizonY + 8);
        vCtx.restore();
      }
      if (this.parallaxMidPattern) {
        const oxMid = ((Math.round(sx * 0.5) % 64) + 64) % 64;
        const midTop = Math.round(camH * 0.25);
        vCtx.save();
        vCtx.translate(-oxMid, midTop);
        vCtx.fillStyle = this.parallaxMidPattern;
        vCtx.fillRect(oxMid, 0, camW + 64, horizonY - midTop + 16);
        vCtx.restore();
      }
      if (this.biomePattern) {
        const oxGround = ((sx % 64) + 64) % 64;
        vCtx.save();
        vCtx.translate(-oxGround, horizonY);
        vCtx.fillStyle = this.biomePattern;
        vCtx.fillRect(oxGround, 0, camW + 64, camH - horizonY + 64);
        vCtx.restore();
      }
      vCtx.fillStyle = 'rgba(15, 23, 42, 0.35)';
      vCtx.fillRect(0, horizonY, camW, 1);
    } else if (this.biomePattern) {
      const ox = ((sx % 64) + 64) % 64;
      const oy = ((sy % 64) + 64) % 64;
      vCtx.save();
      vCtx.translate(-ox, -oy);
      vCtx.fillStyle = this.biomePattern;
      vCtx.fillRect(ox, oy, camW + 64, camH + 64);
      vCtx.restore();
    }

    // 2. Biome dimmer overlay strictly over terrain before drawing sprite
    if (this.config.biomeDimmer < 0.999) {
      vCtx.fillStyle = `rgba(0, 0, 0, ${(1 - this.config.biomeDimmer).toFixed(3)})`;
      vCtx.fillRect(0, 0, camW, camH);
    }

    // 3. Optional 16px / 32px world-locked tile grid ruler
    if (this.config.gridSize > 0) {
      const g = this.config.gridSize;
      const gxOff = ((sx % g) + g) % g;
      const gyOff = this.config.projection === 'side-scroller' ? 0 : ((sy % g) + g) % g;
      vCtx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      for (let x = -gxOff; x < camW; x += g) {
        vCtx.fillRect(Math.round(x), 0, 1, camH);
      }
      for (let y = -gyOff; y < camH; y += g) {
        vCtx.fillRect(0, Math.round(y), camW, 1);
      }
    }

    // 4. Sprite anchored at exact pivotPx + grounded contact shadow + hit-flash / lens
    const activeFrame = this.frameBank[this.state.frameIndex] ?? this.frameBank[0];
    if (activeFrame) {
      const pivotX = Math.round(this.config.pivotNorm.x * activeFrame.width);
      const pivotY = Math.round(this.config.pivotNorm.y * activeFrame.height);
      const drawX = Math.round(
        this.state.posX + this.state.knockbackOffsetX + this.state.shakeOffsetX,
      );
      const drawY = Math.round(this.state.posY + this.state.bobOffsetY + this.state.shakeOffsetY);

      // Soft contact shadow anchored directly beneath pivot
      const shadowW = Math.max(10, Math.round(activeFrame.width * 0.24));
      const shadowH = Math.max(3, Math.round(shadowW * 0.28));
      vCtx.save();
      vCtx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      vCtx.beginPath();
      vCtx.ellipse(
        drawX,
        Math.round(this.state.posY + this.state.shakeOffsetY),
        shadowW,
        shadowH,
        0,
        0,
        Math.PI * 2,
      );
      vCtx.fill();
      vCtx.restore();

      vCtx.save();
      vCtx.translate(drawX, drawY);
      if (this.state.flipped) {
        vCtx.scale(-1, 1);
      }

      if (this.config.lens === 'silhouette') {
        const silCanvas =
          this.contrastReport.biomeLuminance >= 0.45
            ? activeFrame.darkSilhouetteCanvas
            : activeFrame.lightSilhouetteCanvas;
        vCtx.drawImage(silCanvas, -pivotX, -pivotY);
      } else {
        vCtx.drawImage(activeFrame.colorCanvas, -pivotX, -pivotY);
        if (this.state.flashAlpha > 0.01) {
          vCtx.globalAlpha = Math.min(1, this.state.flashAlpha);
          vCtx.drawImage(activeFrame.flashCanvas, -pivotX, -pivotY);
          vCtx.globalAlpha = 1;
        }
      }
      vCtx.restore();
    }

    // 5. Blit virtual camera onto visible display canvas at exact integer scale + Value lens filter
    dCtx.save();
    dCtx.clearRect(0, 0, this.displayCanvas.width, this.displayCanvas.height);
    dCtx.imageSmoothingEnabled = !pixelArt;
    dCtx.filter = this.config.lens === 'value' ? 'grayscale(100%)' : 'none';
    dCtx.drawImage(this.virtualCanvas, 0, 0, camW * this.config.scale, camH * this.config.scale);
    dCtx.filter = 'none';
    dCtx.restore();

    this.ticks += 1;
    this.displayCanvas.dataset.ticks = String(this.ticks);
    this.displayCanvas.dataset.flipped = this.state.flipped ? 'true' : 'false';
    this.displayCanvas.dataset.flashActive = this.state.flashAlpha > 0 ? 'true' : 'false';
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.handleVisibilityBound);
    this.releaseBiomeCanvases();
    this.releaseFrameBank();
    releaseCanvas(this.virtualCanvas);
    this.activeKeys.clear();
  }
}
