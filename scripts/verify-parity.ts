import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ParityCheckInput {
  readonly rootVersion: string;
  readonly extensionVersion: string;
  readonly modelRouterVersion: string;
  readonly desktopProductVersion: string;
  readonly desktopTelemetryEnabled: boolean | undefined;
  readonly desktopEnableTelemetry: boolean | undefined;
  readonly desktopBundledExtensionIds: readonly string[];
  readonly expectedExtensionId: string;
  readonly workspaceTabs: readonly string[];
  readonly expectedRequiredTabs: readonly string[];
  readonly studioToolNames: readonly string[];
  readonly mcpToolNames: readonly string[];
  readonly extensionLmToolNames: readonly string[];
  readonly recipeSchemaVersion: string;
}

export interface ParityReport {
  readonly ok: boolean;
  readonly version: string;
  readonly errors: readonly string[];
  readonly summary: {
    readonly tabCount: number;
    readonly studioToolCount: number;
    readonly mcpToolCount: number;
    readonly recipeSchemaVersion: string;
  };
}

export const EXPECTED_REQUIRED_INSPECTOR_TABS: readonly string[] = [
  'postprocess',
  'normal',
  'puppet',
  'pose',
  'sockets',
  'vfx-baker',
  'tile-slice',
  'autotile',
  'parallax',
  'room',
  'world-map',
  'data-foundry',
  'dialogue-l10n',
  'ship-godot',
  'bmfont',
  'uikit',
  'palette-lut',
  'collider',
  'sandbox',
  'shader',
  'turnaround',
];

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Pure parity & version-lock evaluator comparing PWA (`package.json`, `workspaceTabs`,
 * `STUDIO_TOOL_NAMES`, `AssetRecipeSchema`) against Desktop/Extension contracts.
 */
export function evaluateParityReport(input: ParityCheckInput): ParityReport {
  const errors: string[] = [];

  const versions: readonly [string, string][] = [
    ['package.json', input.rootVersion],
    ['packages/vscode-extension/package.json', input.extensionVersion],
    ['packages/model-router/package.json', input.modelRouterVersion],
    ['desktop/product.json', input.desktopProductVersion],
  ];

  for (const [label, ver] of versions) {
    if (!SEMVER_REGEX.test(ver)) {
      errors.push(`Manifest "${label}" has invalid SemVer version "${ver}".`);
    }
    if (ver !== input.rootVersion) {
      errors.push(
        `Version mismatch: "${label}" has "${ver}" but root package.json has "${input.rootVersion}".`,
      );
    }
  }

  if (input.desktopTelemetryEnabled !== false || input.desktopEnableTelemetry !== false) {
    errors.push(
      'desktop/product.json must explicitly set both telemetryEnabled=false and enableTelemetry=false.',
    );
  }

  if (!input.desktopBundledExtensionIds.includes(input.expectedExtensionId)) {
    errors.push(
      `desktop/product.json builtInExtensions is missing expected bundled extension "${input.expectedExtensionId}".`,
    );
  }

  const seenTabs = new Set<string>();
  for (const tab of input.workspaceTabs) {
    if (seenTabs.has(tab)) {
      errors.push(`Duplicate workspace tab "${tab}" detected in ALL_INSPECTOR_TABS.`);
    }
    seenTabs.add(tab);
  }
  for (const reqTab of input.expectedRequiredTabs) {
    if (!seenTabs.has(reqTab)) {
      errors.push(`Missing required inspector tab "${reqTab}" in workspaceTabs.ts.`);
    }
  }

  const mcpSet = new Set(input.mcpToolNames);
  const lmSet = new Set(input.extensionLmToolNames);

  for (const toolName of input.studioToolNames) {
    if (!mcpSet.has(toolName)) {
      errors.push(`M38 studio tool "${toolName}" is missing from MCP server registration.`);
    }
    const expectedLmName = `nibgrid_${toolName}`;
    if (!lmSet.has(expectedLmName)) {
      errors.push(
        `M38 studio tool "${toolName}" is missing from packages/vscode-extension languageModelTools as "${expectedLmName}".`,
      );
    }
  }

  if (!mcpSet.has('run_vertical_slice')) {
    errors.push('M37 tool "run_vertical_slice" is missing from MCP server registration.');
  }
  if (!lmSet.has('nibgrid_run_vertical_slice')) {
    errors.push(
      'M37 tool "nibgrid_run_vertical_slice" is missing from packages/vscode-extension languageModelTools.',
    );
  }

  if (!SEMVER_REGEX.test(input.recipeSchemaVersion)) {
    errors.push(
      `Invalid AssetRecipe schemaVersion "${input.recipeSchemaVersion}" in recipeBuilder.ts.`,
    );
  }

  return {
    ok: errors.length === 0,
    version: input.rootVersion,
    errors,
    summary: {
      tabCount: seenTabs.size,
      studioToolCount: input.studioToolNames.length,
      mcpToolCount: mcpSet.size,
      recipeSchemaVersion: input.recipeSchemaVersion,
    },
  };
}

function extractStringArrayConst(sourceText: string, constName: string): string[] {
  const match = new RegExp(
    `export const ${constName}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s*as const)?;`,
  ).exec(sourceText);
  if (!match?.[1]) {
    throw new Error(`Could not locate string array constant "${constName}".`);
  }
  const items: string[] = [];
  const itemRegex = /'([^']+)'/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRegex.exec(match[1])) !== null) {
    if (itemMatch[1]) {
      items.push(itemMatch[1]);
    }
  }
  return items;
}

/**
 * Collects live manifests, workspace tabs, M38 studio tools, MCP tools, and recipe schema
 * directly from repository files for offline parity verification.
 */
export async function collectRepoParityInput(repoRoot = process.cwd()): Promise<ParityCheckInput> {
  const root = resolve(repoRoot);
  const [
    rootPkgRaw,
    extPkgRaw,
    routerPkgRaw,
    productRaw,
    tabsSource,
    registrySource,
    mcpSource,
    recipeSource,
  ] = await Promise.all([
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, 'packages/vscode-extension/package.json'), 'utf8'),
    readFile(join(root, 'packages/model-router/package.json'), 'utf8'),
    readFile(join(root, 'desktop/product.json'), 'utf8'),
    readFile(join(root, 'src/ui/inspector/workspaceTabs.ts'), 'utf8'),
    readFile(join(root, 'src/agent/studioToolRegistry.ts'), 'utf8'),
    readFile(join(root, 'packages/vscode-extension/src/mcpToolServer.ts'), 'utf8'),
    readFile(join(root, 'src/export/recipeBuilder.ts'), 'utf8'),
  ]);

  const rootPkg = JSON.parse(rootPkgRaw) as { version?: string };
  const extPkg = JSON.parse(extPkgRaw) as {
    name?: string;
    publisher?: string;
    version?: string;
    contributes?: { languageModelTools?: { name: string }[] };
  };
  const routerPkg = JSON.parse(routerPkgRaw) as { version?: string };
  const product = JSON.parse(productRaw) as {
    version?: string;
    telemetryEnabled?: boolean;
    enableTelemetry?: boolean;
    builtInExtensions?: { name: string }[];
  };

  const workspaceTabs = extractStringArrayConst(tabsSource, 'ALL_INSPECTOR_TABS');
  const studioToolNames = extractStringArrayConst(registrySource, 'STUDIO_TOOL_NAMES');

  // Verify mcpToolServer derives directly from STUDIO_GEMINI_TOOL_DECLARATIONS + run_vertical_slice
  const mcpToolNames: string[] = [];
  if (mcpSource.includes('...STUDIO_GEMINI_TOOL_DECLARATIONS.map')) {
    const declBlockMatch =
      /export const STUDIO_GEMINI_TOOL_DECLARATIONS\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(
        registrySource,
      );
    const declText = declBlockMatch?.[1] ?? '';
    const declNameRegex = /\bname:\s*'([a-z0-9_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = declNameRegex.exec(declText)) !== null) {
      if (m[1]) mcpToolNames.push(m[1]);
    }
  }
  if (/name:\s*'run_vertical_slice'/.test(mcpSource)) {
    mcpToolNames.push('run_vertical_slice');
  }

  const recipeVerMatch = /export const RECIPE_SCHEMA_VERSION\s*=\s*'([^']+)'/.exec(recipeSource);

  return {
    rootVersion: rootPkg.version ?? '',
    extensionVersion: extPkg.version ?? '',
    modelRouterVersion: routerPkg.version ?? '',
    desktopProductVersion: product.version ?? '',
    desktopTelemetryEnabled: product.telemetryEnabled,
    desktopEnableTelemetry: product.enableTelemetry,
    desktopBundledExtensionIds: (product.builtInExtensions ?? []).map((e) => e.name),
    expectedExtensionId: `${extPkg.publisher ?? 'franekjemiolo'}.${extPkg.name ?? 'nibgrid-studio'}`,
    workspaceTabs,
    expectedRequiredTabs: EXPECTED_REQUIRED_INSPECTOR_TABS,
    studioToolNames,
    mcpToolNames,
    extensionLmToolNames: (extPkg.contributes?.languageModelTools ?? []).map((t) => t.name),
    recipeSchemaVersion: recipeVerMatch?.[1] ?? '',
  };
}

export async function runRepoParityCheck(repoRoot = process.cwd()): Promise<ParityReport> {
  const input = await collectRepoParityInput(repoRoot);
  return evaluateParityReport(input);
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const report = await runRepoParityCheck(process.cwd());
  if (report.ok) {
    console.log(JSON.stringify(report));
  } else {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  }
}
