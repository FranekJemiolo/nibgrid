import { describe, expect, it } from 'vitest';
import {
  appendChildNode,
  deleteLeafNode,
  forkFromAncestor,
  getAncestorPath,
  validateDagAcyclicity,
} from '../../src/domain/dag';
import { MANDATORY_CUTOUT_CONSTRAINTS, compilePrompt } from '../../src/domain/promptCompiler';
import {
  DEFAULT_NEGATIVE_PROMPT,
  createDefaultArtBible,
  type SpriteNode,
} from '../../src/domain/schemas';
import { OFFLINE_MOCK_PROVIDER_ID, createDefaultMockProviderConfig } from '../../src/db/database';
import { offlineMockProvider } from '../../src/providers/mockProvider';

function makeNode(
  id: string,
  parentId: string | null,
  kind: SpriteNode['kind'],
  createdAtOffsetMs: number,
): SpriteNode {
  return {
    id,
    projectId: 'proj-1',
    parentId,
    kind,
    imageBlobId: `blob-${id}`,
    sketchSha256: 'a'.repeat(64),
    generationMeta: {
      providerId: OFFLINE_MOCK_PROVIDER_ID,
      modelId: 'nibgrid-procedural-v1',
      seed: 100 + createdAtOffsetMs,
      adherence: 'balanced',
      promptDelta: `delta-${id}`,
      compiledPrompt: `compiled-${id}`,
      createdAt: new Date(1700000000000 + createdAtOffsetMs).toISOString(),
    },
  };
}

function makeSyntheticSketchRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  for (let y = 12; y < height - 12; y++) {
    for (let x = 16; x < width - 16; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 20;
      rgba[idx + 1] = 20;
      rgba[idx + 2] = 20;
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

describe('M3 Prompt Compiler', () => {
  it('always embeds Art Bible projection, lighting, palette, cutout constraints, and negative rules', () => {
    const bible = {
      ...createDefaultArtBible(),
      projection: 'isometric' as const,
      lighting: 'top-right' as const,
      artMode: 'pixel-art' as const,
      palette: ['#1A1C2C', '#B13E53', '#FFCD75'],
      negativePrompt: '',
    };

    const compiled = compilePrompt(bible, {
      adherence: 'strict',
      promptDelta: 'metallic armor trim',
    });

    expect(compiled.positivePrompt).toContain('isometric');
    expect(compiled.positivePrompt).toContain('top-right');
    expect(compiled.positivePrompt).toContain('pixel-art');
    expect(compiled.positivePrompt).toContain(MANDATORY_CUTOUT_CONSTRAINTS);
    expect(compiled.positivePrompt).toContain('#1A1C2C, #B13E53, #FFCD75');
    expect(compiled.positivePrompt).toContain('strictly preserve');
    expect(compiled.positivePrompt).toContain('metallic armor trim');

    for (const token of DEFAULT_NEGATIVE_PROMPT.split(',').map((s) => s.trim())) {
      expect(compiled.negativePrompt.toLowerCase()).toContain(token.toLowerCase());
    }
  });
});

describe('M3 DAG State Engine', () => {
  it('rejects self-parenting and cycles, preserves siblings on leaf deletion, and maintains ancestry', () => {
    const root = makeNode('root', null, 'sketch', 0);
    const var1 = makeNode('var1', 'root', 'generation', 1);
    const var2 = makeNode('var2', 'root', 'generation', 2);
    const inpaint = makeNode('inpaint1', 'var2', 'inpaint', 3);

    let dag = appendChildNode([], root);
    dag = appendChildNode(dag, var1);
    dag = appendChildNode(dag, var2);
    dag = appendChildNode(dag, inpaint);

    expect(validateDagAcyclicity(dag).valid).toBe(true);
    expect(getAncestorPath(dag, 'inpaint1').map((n) => n.id)).toEqual(['root', 'var2', 'inpaint1']);

    // Self-parenting rejected
    const selfParent = makeNode('bad-self', 'bad-self', 'generation', 4);
    expect(() => appendChildNode(dag, selfParent)).toThrow(/cannot reference itself/i);

    // Cycle check catches A -> B -> A
    const cycleNodes: SpriteNode[] = [
      { ...makeNode('cycA', 'cycB', 'generation', 1) },
      { ...makeNode('cycB', 'cycA', 'generation', 2) },
    ];
    expect(validateDagAcyclicity(cycleNodes).valid).toBe(false);

    // Non-leaf node deletion must fail
    expect(() => deleteLeafNode(dag, 'var2')).toThrow(/child branch/i);

    // Deleting leaf inpaint1 preserves var1, var2, and root
    const afterDelete = deleteLeafNode(dag, 'inpaint1');
    expect(afterDelete.map((n) => n.id)).toEqual(['root', 'var1', 'var2']);

    // Forking from root returns valid ancestor
    expect(forkFromAncestor(afterDelete, 'root').id).toBe('root');
  });
});

describe('M3 Deterministic Offline Mock Provider', () => {
  it('returns byte-identical PNGs for identical inputs and distinct output on seed change', async () => {
    const config = createDefaultMockProviderConfig();
    const bible = {
      ...createDefaultArtBible(),
      targetWidth: 48,
      targetHeight: 48,
      palette: ['#1A1C2C', '#B13E53', '#FFCD75', '#38B764'],
    };
    const sketchRgba = makeSyntheticSketchRgba(48, 48);
    const compiled = compilePrompt(bible, {
      adherence: 'balanced',
      promptDelta: 'metallic armor trim',
    });

    const req = {
      config,
      artBible: bible,
      sketchRgba,
      sketchWidth: 48,
      sketchHeight: 48,
      sketchSha256: 'b'.repeat(64),
      seed: 777,
      adherence: 'balanced' as const,
      promptDelta: 'metallic armor trim',
      compiledPrompt: compiled.fullCompiledPrompt,
      variantCount: 1,
    };

    const run1 = await offlineMockProvider.generate(req);
    const run2 = await offlineMockProvider.generate(req);

    expect(run1).toHaveLength(1);
    expect(run1[0]!.sha256).toBe(run2[0]!.sha256);
    expect(Array.from(run1[0]!.pngBytes)).toEqual(Array.from(run2[0]!.pngBytes));

    // Confirm genuine multi-color sprite output (not blank)
    const distinctColors = new Set<string>();
    const rgba = run1[0]!.rgba;
    for (let i = 0; i < rgba.length; i += 4) {
      distinctColors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
    }
    expect(distinctColors.size).toBeGreaterThanOrEqual(3);

    // Changing seed produces distinct output
    const differentSeedRun = await offlineMockProvider.generate({
      ...req,
      seed: 778,
    });
    expect(differentSeedRun[0]!.sha256).not.toBe(run1[0]!.sha256);
  });

  it('inpaint() leaves 100% of unmasked pixels byte-identical while modifying masked pixels', async () => {
    const config = createDefaultMockProviderConfig();
    const bible = {
      ...createDefaultArtBible(),
      targetWidth: 48,
      targetHeight: 48,
    };
    const sketchRgba = makeSyntheticSketchRgba(48, 48);
    const compiled = compilePrompt(bible, {
      adherence: 'balanced',
      promptDelta: 'glowing visor',
    });

    const [generated] = await offlineMockProvider.generate({
      config,
      artBible: bible,
      sketchRgba,
      sketchWidth: 48,
      sketchHeight: 48,
      sketchSha256: 'c'.repeat(64),
      seed: 42,
      adherence: 'balanced',
      promptDelta: 'base armor',
      compiledPrompt: compiled.fullCompiledPrompt,
      variantCount: 1,
    });

    const baseRgba = generated!.rgba;
    const mask = new Uint8Array(48 * 48);
    for (let y = 18; y < 28; y++) {
      for (let x = 18; x < 28; x++) {
        mask[y * 48 + x] = 1;
      }
    }

    const [inpainted] = await offlineMockProvider.inpaint({
      config,
      artBible: bible,
      sketchRgba,
      baseImageRgba: baseRgba,
      mask,
      sketchWidth: 48,
      sketchHeight: 48,
      sketchSha256: 'c'.repeat(64),
      seed: 42,
      adherence: 'balanced',
      promptDelta: 'glowing visor',
      compiledPrompt: compiled.fullCompiledPrompt,
      variantCount: 1,
    });

    const outRgba = inpainted!.rgba;
    let maskedChanged = 0;
    for (let i = 0; i < mask.length; i++) {
      const px = i * 4;
      if (mask[i] === 0) {
        expect(outRgba[px]).toBe(baseRgba[px]);
        expect(outRgba[px + 1]).toBe(baseRgba[px + 1]);
        expect(outRgba[px + 2]).toBe(baseRgba[px + 2]);
        expect(outRgba[px + 3]).toBe(baseRgba[px + 3]);
      } else {
        if (
          outRgba[px] !== baseRgba[px] ||
          outRgba[px + 1] !== baseRgba[px + 1] ||
          outRgba[px + 2] !== baseRgba[px + 2]
        ) {
          maskedChanged++;
        }
      }
    }
    expect(maskedChanged).toBeGreaterThan(0);
  });
});
