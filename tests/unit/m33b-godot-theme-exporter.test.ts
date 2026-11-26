import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultUiKitConfig,
  ProviderConfigSchema,
} from '../../src/domain/schemas';
import { assembleGodotUiKitFiles, exportGodotThemeTres } from '../../src/export/godotThemeExporter';
import { bakeBitmapFontAtlas } from '../../src/processing/bitmapFont';
import { buildBuiltInGlyphMasks } from '../../src/processing/pixelGlyphTable';
import { ALL_UI_WIDGET_SLOTS, bakeProceduralUiKit } from '../../src/processing/uiKitCore';
import { ProviderError } from '../../src/providers/errors';
import { buildGeminiUiKitRequest, generateUiKitViaAi } from '../../src/providers/uiKitAdapter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M33B Godot 4 Theme .tres Exporter & GenAI UI Kit Adapter', () => {
  it('computes exact load_steps and serializes StyleBoxTexture resources with and without linked M24 FontFile', () => {
    const withFont = exportGodotThemeTres({
      slug: 'ui_rpg',
      margins: { left: 6, top: 6, right: 6, bottom: 6 },
      contentMarginPx: 6,
      linkedFontFilename: 'hud_font.fnt',
      referenceTileSize: 32,
    });
    // 8 ext_resources + 7 sub_resources + 1 = 16
    expect(withFont).toContain('[gd_resource type="Theme" load_steps=16 format=3]');
    expect(withFont).toContain(
      '[ext_resource type="FontFile" path="res://assets/nibgrid/ui_rpg/hud_font.fnt" id="8_font"]',
    );
    expect(withFont).toContain('default_font = ExtResource("8_font")');
    expect(withFont).toContain('Button/styles/normal = SubResource("StyleBoxTexture_btn_n")');
    expect(withFont).toContain('Button/styles/hover = SubResource("StyleBoxTexture_btn_h")');
    expect(withFont).toContain('Button/styles/pressed = SubResource("StyleBoxTexture_btn_p")');
    expect(withFont).toContain('Button/styles/disabled = SubResource("StyleBoxTexture_btn_d")');
    expect(withFont).toContain('PanelContainer/styles/panel = SubResource("StyleBoxTexture_pnl")');
    expect(withFont).toContain(
      'ProgressBar/styles/background = SubResource("StyleBoxTexture_bar_t")',
    );
    expect(withFont).toContain('ProgressBar/styles/fill = SubResource("StyleBoxTexture_bar_f")');

    const noFont = exportGodotThemeTres({
      slug: 'ui_minimal',
      margins: { left: 4, top: 4, right: 4, bottom: 4 },
      contentMarginPx: 4,
      referenceTileSize: 32,
    });
    // 7 ext_resources + 7 sub_resources + 1 = 15
    expect(noFont).toContain('[gd_resource type="Theme" load_steps=15 format=3]');
    expect(noFont).not.toContain('default_font');
  });

  it('assembles 7 PNGs, 7 lossless .png.import sidecars, linked M24 font files, and Theme .tres', () => {
    const cfg = createDefaultUiKitConfig(['#1A1C2C', '#FFCD75', '#B13E53']);
    const kit = bakeProceduralUiKit({ ...cfg, slug: 'ui_fantasy' });
    const font = bakeBitmapFontAtlas(buildBuiltInGlyphMasks('0123456789'), {
      fontName: 'hud_font',
      scale: 2,
      topRgb: [255, 205, 117],
      bottomRgb: [239, 125, 87],
      outlineMode: 1,
      selOutDarken: 0.55,
      shadowOffsetX: 0,
      shadowOffsetY: 1,
      shadowRgb: [26, 28, 44],
      shadowAlpha: 180,
      letterSpacingPx: 1,
      paddingPx: 2,
    });

    const files = assembleGodotUiKitFiles(kit, {
      isPixelArt: true,
      linkedFont: { filenameBase: 'hud_font', font },
    });

    const paths = files.map((f) => f.relativePath);
    for (const slot of ALL_UI_WIDGET_SLOTS) {
      const pngFile = files.find((f) => f.relativePath.endsWith(`/${slot}.png`));
      const importFile = files.find((f) => f.relativePath.endsWith(`/${slot}.png.import`));
      expect(pngFile).toBeDefined();
      expect(Array.from((pngFile!.content as Uint8Array).slice(0, 4))).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
      expect(importFile?.content).toContain('compress/mode=0');
      expect(importFile?.content).toContain('mipmaps/generate=false');
    }
    expect(paths).toContain('assets/nibgrid/ui_fantasy/hud_font.fnt');
    expect(paths).toContain('assets/nibgrid/ui_fantasy/hud_font.png');
    expect(paths).toContain('assets/nibgrid/ui_fantasy/ui_fantasy_theme.tres');
  });

  it('compiles #FF00FF chroma UI sheet requests and strips dummy key AIzaSyUIKIT999 on HTTP 401/429', async () => {
    const bible = createDefaultArtBible();
    const payload = buildGeminiUiKitRequest('ornate stone buttons', bible);
    const promptText = (payload.contents[0].parts[0] as { text: string }).text;
    expect(promptText).toContain('#FF00FF');
    expect(promptText).toContain('ornate stone buttons');

    const dummyKey = 'AIzaSyUIKIT999';
    const geminiCfg = ProviderConfigSchema.parse({
      id: 'gemini-uikit',
      kind: 'gemini',
      displayName: 'Gemini Image',
      modelId: 'gemini-2.5-flash-image',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: dummyKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    });

    for (const status of [401, 429]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(`Invalid credentials: ${dummyKey}`, { status }),
      );
      let caught: unknown;
      try {
        await generateUiKitViaAi(
          'stone ui',
          createDefaultUiKitConfig(bible.palette),
          bible,
          geminiCfg,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const err = caught as ProviderError;
      expect(err.message).not.toContain(dummyKey);
      expect(err.remediation).not.toContain(dummyKey);
    }
  });
});
