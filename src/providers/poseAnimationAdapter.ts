import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import { parseHexRgb } from '../processing/backgroundKey';
import {
  encodeRgbaToPngBytes,
  base64ToUint8,
  decodePngBytesToRgba,
  uint8ToBase64,
} from '../processing/png';
import {
  ALL_POSE_JOINT_IDS,
  POSE_BONES,
  packFramesToHorizontalStrip,
  renderOpenPoseFrame,
  renderOpenPoseStrip,
  sliceAndAlignPoseStrip,
  type PoseClipDefinition,
  type PoseKeyframe,
  type RgbTriplet,
  type SliceAndAlignPoseOptions,
} from '../processing/poseRigCore';
import type { RgbaBuffer } from '../processing/types';
import { getBridgeSessionToken, resolveBridgeBaseUrl } from './antigravityBridgeProvider';
import { BridgeGenerateResponseSchema } from './bridgeContract';
import { classifyProviderError, ProviderError } from './errors';
import {
  extractImageBase64FromGeminiResponse,
  resolveGeminiBaseUrl,
  type GeminiGenerateContentPayload,
  type GeminiGenerateContentResponse,
} from './geminiProvider';

export interface PoseGenerationCostEstimate {
  readonly estimatedUsd: number;
  readonly label: string;
}

export function estimatePoseCycleCost(
  kind: ProviderKind,
  frameCount: number,
): PoseGenerationCostEstimate {
  const safeCount = Math.max(1, Math.round(frameCount));
  switch (kind) {
    case 'mock':
    case 'antigravity-agent':
      return { estimatedUsd: 0, label: `Offline Mock • $0.00` };
    case 'comfyui':
      return { estimatedUsd: 0, label: `1×${safeCount} ControlNet • $0.00 Local` };
    case 'antigravity-bridge':
      return { estimatedUsd: 0, label: `1×${safeCount} Strip • $0.00 Bridge` };
    case 'gemini':
      return { estimatedUsd: 0.04, label: `1×${safeCount} Strip • ~$0.04` };
    default:
      return { estimatedUsd: 0.04, label: `1×${safeCount} Strip • ~$0.04` };
  }
}

/**
 * Compiles a multimodal Gemini Image / Antigravity Bridge request containing BOTH the
 * Character Golden Reference PNG and the 1×N OpenPose color-coded guide strip PNG.
 */
export function buildGeminiPoseStripRequest(
  goldenRefPngBase64: string,
  openPoseStripPngBase64: string,
  clip: PoseClipDefinition,
  artBible: ArtBible,
): GeminiGenerateContentPayload {
  const frameCount = Math.max(1, clip.frames.length);
  const palette =
    artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #FFCD75, #B13E53';
  const text = [
    `Generate a clean horizontal 1x${frameCount} sprite sheet animation strip ("${clip.slug}") matching the exact character design, outfit, silhouette proportions, palette, and shading of Image 1 (Character Reference).`,
    `Pose each cell 0..${frameCount - 1} left-to-right to match the corresponding OpenPose stick-figure cell in Image 2 (OpenPose 1x${frameCount} Guide Strip). Respect OpenPose left/right limb colors cleanly so arms and legs never swap sides.`,
    `Place EVERY frame centered cleanly over a shared horizontal ground line on a flat solid #FF00FF magenta chroma background with zero text, numbers, borders, or drop shadows.`,
    `ART BIBLE LOCK: artMode=${artBible.artMode}, projection=${artBible.projection}, lighting=${artBible.lighting}, style="${artBible.stylePrompt}", negative="${artBible.negativePrompt}", palette=[${palette}].`,
  ].join('\n');

  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: goldenRefPngBase64,
            },
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: openPoseStripPngBase64,
            },
          },
          { text },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

/**
 * Compiles a surgical single-frame re-roll request carrying Reference + Prev Frame + Target OpenPose Guide.
 */
export function buildGeminiSingleFrameRerollRequest(
  goldenRefPngBase64: string,
  prevFramePngBase64: string,
  targetPosePngBase64: string,
  artBible: ArtBible,
): GeminiGenerateContentPayload {
  const palette = artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #FFCD75';
  const text = [
    'Generate ONE single animation frame matching Image 1 (Character Reference) and maintaining frame-to-frame outfit continuity with Image 2 (Adjacent Frame).',
    'Match the exact limb pose and prop arc shown in Image 3 (Target OpenPose Stick-Figure Guide).',
    'Render centered on a flat solid #FF00FF magenta chroma background with crisp edges and zero drop shadow or UI overlays.',
    `ART BIBLE LOCK: artMode=${artBible.artMode}, projection=${artBible.projection}, lighting=${artBible.lighting}, style="${artBible.stylePrompt}", palette=[${palette}].`,
  ].join('\n');

  return {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: goldenRefPngBase64 } },
          { inlineData: { mimeType: 'image/png', data: prevFramePngBase64 } },
          { inlineData: { mimeType: 'image/png', data: targetPosePngBase64 } },
          { text },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

function drawFilledCapsule(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  rgb: RgbTriplet,
): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
  const sx = x1 - x0;
  const sy = y1 - y0;
  const lenSq = sx * sx + sy * sy;
  const rSq = radius * radius;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let dSq: number;
      if (lenSq <= 1e-6) {
        const dx = x - x0;
        const dy = y - y0;
        dSq = dx * dx + dy * dy;
      } else {
        const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / lenSq));
        const px = x0 + t * sx;
        const py = y0 + t * sy;
        const dx = x - px;
        const dy = y - py;
        dSq = dx * dx + dy * dy;
      }
      if (dSq <= rSq) {
        const idx = (y * width + x) * 4;
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  }
}

/**
 * Renders a deterministic pixel-art mannequin silhouette from a `PoseKeyframe`
 * using `ArtBible.palette` colors on a `#FF00FF` chroma background for `$0.00` offline mode.
 */
export function renderOfflineMockPoseFrame(
  keyframe: PoseKeyframe,
  widthPx: number,
  heightPx: number,
  paletteHex: readonly string[] = [],
): RgbaBuffer {
  const width = Math.max(16, Math.round(widthPx));
  const height = Math.max(16, Math.round(heightPx));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 0;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  const pickRgb = (idx: number, fallback: RgbTriplet): RgbTriplet => {
    const hex = paletteHex[idx];
    if (!hex) return fallback;
    const c = parseHexRgb(hex);
    return [c.r, c.g, c.b];
  };

  const outlineRgb = pickRgb(0, [26, 28, 44]);
  const bodyRgb = pickRgb(1, [177, 62, 83]);
  const accentRgb = pickRgb(2, [255, 205, 117]);
  const limbRadius = Math.max(1.8, Math.min(width, height) / 20);
  const torsoRadius = Math.max(2.6, Math.min(width, height) / 11);
  const headRadius = Math.max(3.0, Math.min(width, height) / 9);

  // Dark outline pass then colored mannequin fill pass
  for (const pass of ['outline', 'fill'] as const) {
    const expand = pass === 'outline' ? 1.15 : 0;
    for (const bone of POSE_BONES) {
      const a = keyframe.joints[bone.from];
      const b = keyframe.joints[bone.to];
      const baseRadius = bone.from === 'neck' && bone.to === 'pelvis' ? torsoRadius : limbRadius;
      const color =
        pass === 'outline'
          ? outlineRgb
          : bone.group === 'right-arm' || bone.group === 'right-leg'
            ? accentRgb
            : bodyRgb;
      drawFilledCapsule(
        data,
        width,
        height,
        a.x * (width - 1),
        a.y * (height - 1),
        b.x * (width - 1),
        b.y * (height - 1),
        baseRadius + expand,
        color,
      );
    }

    if (keyframe.propLine) {
      const [pa, pb] = keyframe.propLine;
      drawFilledCapsule(
        data,
        width,
        height,
        pa.x * (width - 1),
        pa.y * (height - 1),
        pb.x * (width - 1),
        pb.y * (height - 1),
        1.1 + expand,
        pass === 'outline' ? outlineRgb : [244, 244, 244],
      );
    }

    const head = keyframe.joints.head;
    drawFilledCapsule(
      data,
      width,
      height,
      head.x * (width - 1),
      head.y * (height - 1),
      head.x * (width - 1),
      head.y * (height - 1),
      headRadius + expand,
      pass === 'outline' ? outlineRgb : accentRgb,
    );
  }

  // Ensure every joint has clean continuity in silhouette
  for (const jointId of ALL_POSE_JOINT_IDS) {
    if (jointId === 'head') continue;
    const j = keyframe.joints[jointId];
    drawFilledCapsule(
      data,
      width,
      height,
      j.x * (width - 1),
      j.y * (height - 1),
      j.x * (width - 1),
      j.y * (height - 1),
      Math.max(1.2, limbRadius * 0.8),
      bodyRgb,
    );
  }

  return { width, height, data };
}

export interface GeneratePoseCycleOptions {
  readonly lockPalette?: boolean;
  readonly groundMarginPx?: number;
  readonly signal?: AbortSignal;
  readonly sliceInWorker?: (
    strip: RgbaBuffer,
    frameCount: number,
    chromaRgb: RgbTriplet,
    opts: SliceAndAlignPoseOptions,
  ) => Promise<readonly RgbaBuffer[]>;
}

export interface GeneratePoseCycleResult {
  readonly frames: readonly RgbaBuffer[];
  readonly openPoseStrip: RgbaBuffer;
  readonly generatedStrip: RgbaBuffer;
  readonly providerLabel: string;
  readonly costEstimate: PoseGenerationCostEstimate;
}

async function runComfyControlNetPose(
  baseUrl: string,
  goldenRefPng: Uint8Array,
  openPoseStripPng: Uint8Array,
  clip: PoseClipDefinition,
  artBible: ArtBible,
  providerId: string,
  signal?: AbortSignal,
): Promise<RgbaBuffer> {
  const uploadPng = async (bytes: Uint8Array, name: string): Promise<string> => {
    const form = new FormData();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append('image', new Blob([copy.buffer], { type: 'image/png' }), name);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw { status: res.status, responseText: body };
    }
    const json = (await res.json()) as { name: string };
    return json.name;
  };

  try {
    const refName = await uploadPng(goldenRefPng, 'nibgrid_pose_ref.png');
    const poseName = await uploadPng(openPoseStripPng, 'nibgrid_pose_openpose.png');

    const promptWorkflow = {
      '1': {
        class_type: 'LoadImage',
        inputs: { image: refName },
      },
      '2': {
        class_type: 'LoadImage',
        inputs: { image: poseName },
      },
      '3': {
        class_type: 'ControlNetLoader',
        inputs: { control_net_name: 'control_v11p_sd15_openpose.pth' },
      },
      '4': {
        class_type: 'ControlNetApply',
        inputs: {
          strength: 0.9,
          control_net: ['3', 0],
          image: ['2', 0],
          positive: `${artBible.stylePrompt}, 1x${clip.frames.length} sprite sheet on #FF00FF`,
        },
      },
    };

    const clientId = globalThis.crypto.randomUUID();
    const queueRes = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, prompt: promptWorkflow }),
      signal,
    });
    if (!queueRes.ok) {
      const body = await queueRes.text().catch(() => '');
      throw { status: queueRes.status, responseText: body };
    }
    const { prompt_id: promptId } = (await queueRes.json()) as { prompt_id: string };

    for (let attempt = 0; attempt < 90; attempt++) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const histRes = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      if (histRes.ok) {
        const hist = (await histRes.json()) as Record<
          string,
          {
            outputs?: Record<
              string,
              { images?: { filename: string; subfolder?: string; type?: string }[] }
            >;
          }
        >;
        const outImg = Object.values(hist[promptId]?.outputs ?? {}).flatMap(
          (o) => o.images ?? [],
        )[0];
        if (outImg) {
          const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(outImg.filename)}&subfolder=${encodeURIComponent(outImg.subfolder ?? '')}&type=${encodeURIComponent(outImg.type ?? 'output')}`;
          const imgRes = await fetch(viewUrl, { signal });
          const decoded = await decodePngBytesToRgba(new Uint8Array(await imgRes.arrayBuffer()));
          return { width: decoded.width, height: decoded.height, data: decoded.rgba };
        }
      }
      await new Promise((r) => globalThis.setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for ComfyUI ControlNet OpenPose prompt "${promptId}".`);
  } catch (err) {
    throw classifyProviderError(err, {
      providerId,
      providerKind: 'comfyui',
      endpointUrl: baseUrl,
    });
  }
}

/**
 * Generates an entire `1×N` sprite sheet conditioned on `[Golden Reference + OpenPose Strip]`
 * via Gemini Image, Antigravity Bridge, ComfyUI ControlNet, or `$0.00` Offline Mock Mode,
 * then slices and ground-pivot aligns all frames deterministically.
 */
export async function generatePoseSpriteCycle(
  goldenRefBuf: RgbaBuffer,
  clip: PoseClipDefinition,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: GeneratePoseCycleOptions = {},
): Promise<GeneratePoseCycleResult> {
  const frameCount = Math.max(1, clip.frames.length);
  const frameW = clip.frameWidthPx;
  const frameH = clip.frameHeightPx;
  const costEstimate = estimatePoseCycleCost(providerConfig.kind, frameCount);
  const openPoseStrip = renderOpenPoseStrip(clip.frames, frameW, frameH);

  const sliceOpts: SliceAndAlignPoseOptions = {
    chromaTolerance: 42,
    groundMarginPx: options.groundMarginPx ?? 2,
    paletteHex: artBible.palette,
    snapToPalette: options.lockPalette ?? true,
  };

  const runSlice = async (rawStrip: RgbaBuffer): Promise<readonly RgbaBuffer[]> => {
    if (options.sliceInWorker) {
      return options.sliceInWorker(rawStrip, frameCount, [255, 0, 255], sliceOpts);
    }
    return sliceAndAlignPoseStrip(rawStrip, frameCount, [255, 0, 255], sliceOpts);
  };

  if (providerConfig.kind === 'mock' || providerConfig.kind === 'antigravity-agent') {
    const rawCells = clip.frames.map((kf) =>
      renderOfflineMockPoseFrame(kf, frameW, frameH, artBible.palette),
    );
    const mockStrip = packFramesToHorizontalStrip(rawCells);
    const frames = await runSlice(mockStrip);
    return {
      frames,
      openPoseStrip,
      generatedStrip: packFramesToHorizontalStrip(frames),
      providerLabel: 'Offline Mock ($0.00)',
      costEstimate,
    };
  }

  const refPng = encodeRgbaToPngBytes(goldenRefBuf.data, goldenRefBuf.width, goldenRefBuf.height);
  const posePng = encodeRgbaToPngBytes(
    openPoseStrip.data,
    openPoseStrip.width,
    openPoseStrip.height,
  );
  const refB64 = uint8ToBase64(refPng);
  const poseB64 = uint8ToBase64(posePng);

  if (providerConfig.kind === 'comfyui') {
    const baseUrl =
      providerConfig.endpointUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8188';
    const rawStrip = await runComfyControlNetPose(
      baseUrl,
      refPng,
      posePng,
      clip,
      artBible,
      providerConfig.id,
      options.signal,
    );
    const frames = await runSlice(rawStrip);
    return {
      frames,
      openPoseStrip,
      generatedStrip: packFramesToHorizontalStrip(frames),
      providerLabel: providerConfig.displayName,
      costEstimate,
    };
  }

  if (providerConfig.kind === 'antigravity-bridge') {
    const baseUrl = resolveBridgeBaseUrl(providerConfig.endpointUrl);
    const token = getBridgeSessionToken(providerConfig.id, providerConfig.apiKey);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Bridge token missing for Pose-to-Sprite generation.',
        remediation: 'Configure the nbg_ bridge bearer token in Provider Vault.',
      });
    }

    try {
      const geminiPayload = buildGeminiPoseStripRequest(refB64, poseB64, clip, artBible);
      const compiledPrompt = (geminiPayload.contents[0].parts[2] as { text: string }).text;
      const res = await fetch(`${baseUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requestId: globalThis.crypto.randomUUID(),
          modelId: providerConfig.modelId,
          compiledPrompt,
          promptDelta: `${clip.slug} pose sprite strip (${frameCount} frames)`,
          negativePrompt: artBible.negativePrompt,
          adherence: 'strict',
          variants: 1,
          sketchPngBase64: poseB64,
          referencePngBase64: refB64,
          artBibleSnapshot: {
            projection: artBible.projection,
            lighting: artBible.lighting,
            artMode: artBible.artMode,
            palette: [...artBible.palette],
          },
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyProviderError(
          { status: res.status, responseText: text },
          {
            providerId: providerConfig.id,
            providerKind: 'antigravity-bridge',
            endpointUrl: baseUrl,
            secrets: [token],
          },
        );
      }
      const parsed = BridgeGenerateResponseSchema.parse(await res.json());
      const first = parsed.variants[0];
      if (!first) throw new Error('Bridge returned zero pose strip images.');
      const decoded = await decodePngBytesToRgba(base64ToUint8(first.pngBase64));
      const frames = await runSlice({
        width: decoded.width,
        height: decoded.height,
        data: decoded.rgba,
      });
      return {
        frames,
        openPoseStrip,
        generatedStrip: packFramesToHorizontalStrip(frames),
        providerLabel: providerConfig.displayName,
        costEstimate,
      };
    } catch (err) {
      throw classifyProviderError(err, {
        providerId: providerConfig.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
    }
  }

  // Gemini BYOK
  const apiKey = providerConfig.apiKey.trim();
  if (!apiKey) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: providerConfig.id,
      retryable: false,
      message: 'Gemini API key is required for GenAI Pose Cycle generation.',
      remediation: 'Add a Gemini API key in Provider Vault or switch to Offline Mock ($0.00).',
    });
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(providerConfig.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = buildGeminiPoseStripRequest(refB64, poseB64, clip, artBible);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText: text },
        {
          providerId: providerConfig.id,
          providerKind: providerConfig.kind,
          endpointUrl: baseUrl,
          secrets: [apiKey],
        },
      );
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    const { base64 } = extractImageBase64FromGeminiResponse(json);
    const decoded = await decodePngBytesToRgba(base64ToUint8(base64));
    const frames = await runSlice({
      width: decoded.width,
      height: decoded.height,
      data: decoded.rgba,
    });
    return {
      frames,
      openPoseStrip,
      generatedStrip: packFramesToHorizontalStrip(frames),
      providerLabel: providerConfig.displayName,
      costEstimate,
    };
  } catch (err) {
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: baseUrl,
      secrets: [apiKey],
    });
  }
}

/**
 * Surgically re-rolls a single animation cell using `[Golden Ref + Prev Frame + Target Pose Guide]`.
 */
export async function regenerateSinglePoseFrame(
  goldenRefBuf: RgbaBuffer,
  prevFrameBuf: RgbaBuffer,
  targetKeyframe: PoseKeyframe,
  frameWidthPx: number,
  frameHeightPx: number,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: GeneratePoseCycleOptions = {},
): Promise<RgbaBuffer> {
  const sliceOpts: SliceAndAlignPoseOptions = {
    chromaTolerance: 42,
    groundMarginPx: options.groundMarginPx ?? 2,
    paletteHex: artBible.palette,
    snapToPalette: options.lockPalette ?? true,
  };

  if (
    providerConfig.kind === 'mock' ||
    providerConfig.kind === 'antigravity-agent' ||
    providerConfig.kind === 'comfyui'
  ) {
    const mockRaw = renderOfflineMockPoseFrame(
      targetKeyframe,
      frameWidthPx,
      frameHeightPx,
      artBible.palette,
    );
    return sliceAndAlignPoseStrip(mockRaw, 1, [255, 0, 255], sliceOpts)[0]!;
  }

  const targetPoseBuf = renderOpenPoseFrame(targetKeyframe, frameWidthPx, frameHeightPx);
  const refB64 = uint8ToBase64(
    encodeRgbaToPngBytes(goldenRefBuf.data, goldenRefBuf.width, goldenRefBuf.height),
  );
  const prevB64 = uint8ToBase64(
    encodeRgbaToPngBytes(prevFrameBuf.data, prevFrameBuf.width, prevFrameBuf.height),
  );
  const poseB64 = uint8ToBase64(
    encodeRgbaToPngBytes(targetPoseBuf.data, targetPoseBuf.width, targetPoseBuf.height),
  );

  if (providerConfig.kind === 'antigravity-bridge') {
    const baseUrl = resolveBridgeBaseUrl(providerConfig.endpointUrl);
    const token = getBridgeSessionToken(providerConfig.id, providerConfig.apiKey);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Bridge token missing for single-frame re-roll.',
        remediation: 'Configure the nbg_ bridge bearer token in Provider Vault.',
      });
    }
    try {
      const payload = buildGeminiSingleFrameRerollRequest(refB64, prevB64, poseB64, artBible);
      const compiledPrompt = (payload.contents[0].parts[3] as { text: string }).text;
      const res = await fetch(`${baseUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requestId: globalThis.crypto.randomUUID(),
          modelId: providerConfig.modelId,
          compiledPrompt,
          promptDelta: 'reroll single pose frame',
          negativePrompt: artBible.negativePrompt,
          adherence: 'strict',
          variants: 1,
          sketchPngBase64: poseB64,
          referencePngBase64: refB64,
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyProviderError(
          { status: res.status, responseText: text },
          {
            providerId: providerConfig.id,
            providerKind: 'antigravity-bridge',
            endpointUrl: baseUrl,
            secrets: [token],
          },
        );
      }
      const parsed = BridgeGenerateResponseSchema.parse(await res.json());
      const first = parsed.variants[0];
      if (!first) throw new Error('Bridge returned zero images for frame re-roll.');
      const decoded = await decodePngBytesToRgba(base64ToUint8(first.pngBase64));
      return sliceAndAlignPoseStrip(
        { width: decoded.width, height: decoded.height, data: decoded.rgba },
        1,
        [255, 0, 255],
        sliceOpts,
      )[0]!;
    } catch (err) {
      throw classifyProviderError(err, {
        providerId: providerConfig.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
    }
  }

  const apiKey = providerConfig.apiKey.trim();
  if (!apiKey) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: providerConfig.id,
      retryable: false,
      message: 'Gemini API key is required to re-roll a pose frame.',
      remediation: 'Add a Gemini API key in Provider Vault or switch to Offline Mock ($0.00).',
    });
  }
  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(providerConfig.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = buildGeminiSingleFrameRerollRequest(refB64, prevB64, poseB64, artBible);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText: text },
        {
          providerId: providerConfig.id,
          providerKind: providerConfig.kind,
          endpointUrl: baseUrl,
          secrets: [apiKey],
        },
      );
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    const { base64 } = extractImageBase64FromGeminiResponse(json);
    const decoded = await decodePngBytesToRgba(base64ToUint8(base64));
    return sliceAndAlignPoseStrip(
      { width: decoded.width, height: decoded.height, data: decoded.rgba },
      1,
      [255, 0, 255],
      sliceOpts,
    )[0]!;
  } catch (err) {
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: baseUrl,
      secrets: [apiKey],
    });
  }
}
