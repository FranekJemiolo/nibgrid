import type { AdherenceLevel, ArtBible, ProviderConfig } from '../domain/schemas';
import { offlineMockProvider } from './mockProvider';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCostEstimate,
  ProviderGenerateRequest,
  ProviderInpaintRequest,
  ProviderOutput,
  ProviderTestResult,
} from './types';

export const ANTIGRAVITY_AGENT_PROVIDER_ID = 'antigravity-agent';

export interface AntigravityPromptBriefInput {
  projectName: string;
  artBible: ArtBible;
  adherence: AdherenceLevel;
  seed: number;
  promptDelta: string;
  compiledPrompt: string;
  negativePrompt: string;
  mode: 'generate' | 'inpaint';
}

export interface NibgridAgentStateSnapshot {
  projectId: string;
  projectName: string;
  targetWidth: number;
  targetHeight: number;
  nodeCount: number;
  activeNodeId: string | null;
  selectedProviderId: string;
}

export interface NibgridAgentBridge {
  getBrief: () => string;
  getState: () => NibgridAgentStateSnapshot;
  importPngBase64: (base64Png: string, promptDeltaOverride?: string) => Promise<string>;
}

declare global {
  interface Window {
    __NIBGRID_AGENT_BRIDGE__?: NibgridAgentBridge;
  }
}

/**
 * Formats a structured Markdown handoff brief containing Art Bible style-lock
 * constraints and compiled generation prompt for Google Antigravity IDE or external AI tools.
 */
export function buildAntigravityPromptBrief(input: AntigravityPromptBriefInput): string {
  const paletteList =
    input.artBible.palette.length > 0 ? input.artBible.palette.join(', ') : 'Unconstrained';

  return [
    `# Nibgrid -> Google Antigravity IDE Sprite Brief`,
    ``,
    `- **Project:** ${input.projectName}`,
    `- **Operation:** ${input.mode === 'inpaint' ? 'Masked Region Inpaint' : 'Full Sprite Generation'}`,
    `- **Projection:** ${input.artBible.projection}`,
    `- **Lighting:** ${input.artBible.lighting}`,
    `- **Art Mode:** ${input.artBible.artMode}`,
    `- **Target Resolution:** ${input.artBible.targetWidth}x${input.artBible.targetHeight}px`,
    `- **Adherence / Seed:** ${input.adherence} / #${input.seed}`,
    `- **Locked Palette (${input.artBible.palette.length}):** ${paletteList}`,
    `- **Prompt Delta:** ${input.promptDelta.trim() || '(none)'}`,
    ``,
    `## Positive Prompt`,
    input.compiledPrompt,
    ``,
    `## Negative Constraints`,
    input.negativePrompt,
    ``,
    `## Handoff Instructions`,
    `1. Export the active sketch PNG if image-to-image reference is needed.`,
    `2. Generate the sprite using Google Antigravity IDE image tooling (\`image-generator\`) or an external model.`,
    `3. Import the resulting PNG via **Import Agent PNG into DAG** or \`window.__NIBGRID_AGENT_BRIDGE__.importPngBase64(b64)\`.`,
  ].join('\n');
}

/**
 * Adapter integrating Google Antigravity IDE / external AI agent workflows into
 * the Nibgrid DAG alongside direct procedural fallback synthesis.
 */
export class AntigravityAgentProvider implements ProviderAdapter {
  readonly id = ANTIGRAVITY_AGENT_PROVIDER_ID;
  readonly displayName = 'Google Antigravity IDE / Agent Handoff';
  readonly capabilities: ProviderCapabilities = {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  };

  async testConnection(_config: ProviderConfig): Promise<ProviderTestResult> {
    return {
      ok: true,
      latencyMs: 1,
      message:
        'Google Antigravity IDE / Agent Handoff bridge ready ($0.00 local handoff & PNG DAG import).',
    };
  }

  estimateCost(_request: ProviderGenerateRequest): ProviderCostEstimate {
    return {
      estimatedUsd: 0,
      label: '$0.00 — Antigravity IDE',
    };
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    return offlineMockProvider.generate(request, signal);
  }

  async inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]> {
    return offlineMockProvider.inpaint(request, signal);
  }
}

export const antigravityAgentProvider = new AntigravityAgentProvider();

