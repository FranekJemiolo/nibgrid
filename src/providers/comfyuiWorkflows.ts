import type { AdherenceLevel } from '../domain/schemas';

export const COMFYUI_WORKFLOW_VERSION = '1.0';

export const ADHERENCE_DENOISE_WEIGHTS: Record<AdherenceLevel, number> = {
  strict: 0.55,
  balanced: 0.72,
  loose: 0.88,
};

export const COMFYUI_PLACEHOLDER_TOKENS = [
  '{{PROMPT}}',
  '{{NEGATIVE}}',
  '{{SEED}}',
  '{{SKETCH_FILENAME}}',
  '{{MASK_FILENAME}}',
  '{{DENOISE}}',
] as const;

export type ComfyUiWorkflowGraph = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
  }
>;

export const DEFAULT_COMFYUI_WORKFLOW_TEMPLATE: ComfyUiWorkflowGraph = {
  '1': {
    class_type: 'CheckpointLoaderSimple',
    inputs: {
      ckpt_name: 'sd_xl_base_1.0.safetensors',
    },
  },
  '2': {
    class_type: 'LoadImage',
    inputs: {
      image: '{{SKETCH_FILENAME}}',
      upload: 'image',
    },
  },
  '3': {
    class_type: 'VAEEncode',
    inputs: {
      pixels: ['2', 0],
      vae: ['1', 2],
    },
  },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: '{{PROMPT}}',
      clip: ['1', 1],
    },
  },
  '5': {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: '{{NEGATIVE}}',
      clip: ['1', 1],
    },
  },
  '6': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{SEED}}',
      steps: 24,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: '{{DENOISE}}',
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['3', 0],
    },
  },
  '7': {
    class_type: 'VAEDecode',
    inputs: {
      samples: ['6', 0],
      vae: ['1', 2],
    },
  },
  '8': {
    class_type: 'SaveImage',
    inputs: {
      filename_prefix: 'nibgrid_sprite',
      images: ['7', 0],
    },
  },
};

export interface InjectComfyUiWorkflowParams {
  baseTemplate?: ComfyUiWorkflowGraph;
  customTemplateJson?: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  adherence: AdherenceLevel;
  sketchFilename: string;
  maskFilename?: string;
}

export interface InjectedComfyUiWorkflow {
  workflowVersion: string;
  denoise: number;
  prompt: ComfyUiWorkflowGraph;
}

function deepCloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepCloneValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepCloneValue(entry);
    }
    return out as T;
  }
  return value;
}

function replacePlaceholders(value: unknown, tokens: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exactMatch = tokens[value];
    if (exactMatch !== undefined) {
      return exactMatch;
    }
    let replaced = value;
    for (const [token, replacement] of Object.entries(tokens)) {
      if (replaced.includes(token)) {
        replaced = replaced.split(token).join(String(replacement));
      }
    }
    return replaced;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, tokens));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = replacePlaceholders(v, tokens);
    }
    return result;
  }

  return value;
}

/**
 * Purely injects prompt, negativePrompt, seed, adherence denoise weight, and image filenames
 * into a cloned ComfyUI API workflow template without mutating the base template.
 */
export function injectComfyUiWorkflow(
  params: InjectComfyUiWorkflowParams,
): InjectedComfyUiWorkflow {
  let templateSource: ComfyUiWorkflowGraph;
  if (params.customTemplateJson?.trim()) {
    templateSource = JSON.parse(params.customTemplateJson) as ComfyUiWorkflowGraph;
  } else {
    templateSource = params.baseTemplate ?? DEFAULT_COMFYUI_WORKFLOW_TEMPLATE;
  }

  const cloned = deepCloneValue(templateSource);
  const denoise = ADHERENCE_DENOISE_WEIGHTS[params.adherence];
  const tokens: Record<string, string | number> = {
    '{{PROMPT}}': params.prompt,
    '{{NEGATIVE}}': params.negativePrompt,
    '{{SEED}}': params.seed,
    '{{SKETCH_FILENAME}}': params.sketchFilename,
    '{{MASK_FILENAME}}': params.maskFilename ?? params.sketchFilename,
    '{{DENOISE}}': denoise,
  };

  const injected = replacePlaceholders(cloned, tokens) as ComfyUiWorkflowGraph;

  return {
    workflowVersion: COMFYUI_WORKFLOW_VERSION,
    denoise,
    prompt: injected,
  };
}
