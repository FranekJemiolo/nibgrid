import { dispatchHostRpcRequest, type HostBridgeHandlers } from './vscodeHostBridge';

export const NIBGRID_CUSTOM_EDITOR_VIEW_TYPES = {
  spriteRecipe: 'nibgrid.spriteRecipe',
  gdshader: 'nibgrid.gdshader',
  roomBlueprint: 'nibgrid.roomBlueprint',
} as const;

export type NibgridCustomEditorMode = 'sprite-recipe' | 'gdshader' | 'room-blueprint' | 'studio';

export interface VscodeWebviewLike {
  html: string;
  readonly cspSource: string;
  postMessage: (message: unknown) => Promise<boolean> | void;
  onDidReceiveMessage: (listener: (msg: unknown) => unknown) => { dispose: () => void };
}

export interface VscodeWebviewPanelLike {
  readonly webview: VscodeWebviewLike;
  onDidDispose: (listener: () => void) => { dispose: () => void };
}

export interface VscodeTextDocumentLike {
  readonly uri: { readonly fsPath?: string; toString: () => string };
  getText: () => string;
}

export interface VscodeCustomTextEditorProviderLike {
  resolveCustomTextEditor: (
    document: VscodeTextDocumentLike,
    webviewPanel: VscodeWebviewPanelLike,
  ) => Promise<void> | void;
}

export interface VscodeCustomEditorRegistryLike {
  registerCustomEditorProvider: (
    viewType: string,
    provider: VscodeCustomTextEditorProviderLike,
    options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } },
  ) => { dispose: () => void };
}

function escapeHtmlAttr(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeInlineJsonForScript(jsonText: string): string {
  return jsonText
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Generates strict nonce-hardened Webview HTML booting Nibgrid's React bundle
 * with `acquireVsCodeApi()` RPC transport.
 */
export function buildNibgridWebviewHtml(opts: {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri?: string;
  readonly editorMode: NibgridCustomEditorMode;
  readonly documentPath: string;
  readonly initialPayloadJson?: string;
}): string {
  const safeNonce = opts.nonce.replace(/[^A-Za-z0-9_-]/g, '');
  const csp = [
    `default-src 'none'`,
    `img-src ${opts.cspSource} data: blob:`,
    `font-src ${opts.cspSource} data:`,
    `style-src ${opts.cspSource} 'nonce-${safeNonce}'`,
    `script-src 'nonce-${safeNonce}'`,
    `connect-src 'none'`,
  ].join('; ');

  const bootPayload = escapeInlineJsonForScript(
    JSON.stringify({
      editorMode: opts.editorMode,
      documentPath: opts.documentPath,
      initialText: opts.initialPayloadJson ?? '',
    }),
  );

  const styleTag = opts.styleUri
    ? `<link rel="stylesheet" nonce="${safeNonce}" href="${escapeHtmlAttr(opts.styleUri)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nibgrid Studio</title>
    ${styleTag}
  </head>
  <body>
    <div id="root" data-nibgrid-mode="${escapeHtmlAttr(opts.editorMode)}"></div>
    <script nonce="${safeNonce}">
      window.__NIBGRID_BOOT__ = ${bootPayload};
      if (typeof acquireVsCodeApi === 'function') {
        window.__nibgridVsCodeApi = acquireVsCodeApi();
      }
    </script>
    <script type="module" nonce="${safeNonce}" src="${escapeHtmlAttr(opts.scriptUri)}"></script>
  </body>
</html>`;
}

export function createCustomEditorProvider(
  _viewType: string,
  editorMode: NibgridCustomEditorMode,
  deps: {
    readonly handlers: HostBridgeHandlers;
    readonly scriptUri?: string;
    readonly styleUri?: string;
    readonly getKnownSecrets?: () => readonly string[];
    readonly nonceFactory?: () => string;
  },
): VscodeCustomTextEditorProviderLike {
  return {
    resolveCustomTextEditor: (document, webviewPanel) => {
      const nonce = (
        deps.nonceFactory ?? (() => globalThis.crypto.randomUUID().replace(/-/g, ''))
      )();
      const docPath = document.uri.fsPath || document.uri.toString();

      webviewPanel.webview.html = buildNibgridWebviewHtml({
        cspSource: webviewPanel.webview.cspSource,
        nonce,
        scriptUri: deps.scriptUri ?? 'vscode-webview://nibgrid/index.js',
        ...(deps.styleUri ? { styleUri: deps.styleUri } : {}),
        editorMode,
        documentPath: docPath,
        initialPayloadJson: document.getText(),
      });

      const msgSub = webviewPanel.webview.onDidReceiveMessage(async (rawMsg) => {
        const response = await dispatchHostRpcRequest(rawMsg, deps.handlers, {
          knownSecrets: deps.getKnownSecrets?.() ?? [],
        });
        await webviewPanel.webview.postMessage(response);
      });

      webviewPanel.onDidDispose(() => {
        msgSub.dispose();
      });
    },
  };
}

/**
 * Registers Nibgrid's 3 Custom Editors (`*.nibgrid.json`, `*.gdshader`, `*.room.json`)
 * on any VS Code-compatible `registerCustomEditorProvider` registry.
 */
export function registerNibgridCustomEditors(
  registry: VscodeCustomEditorRegistryLike,
  handlers: HostBridgeHandlers,
  opts: {
    readonly scriptUri?: string;
    readonly styleUri?: string;
    readonly getKnownSecrets?: () => readonly string[];
    readonly nonceFactory?: () => string;
  } = {},
): { dispose: () => void }[] {
  const entries: readonly [string, NibgridCustomEditorMode][] = [
    [NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.spriteRecipe, 'sprite-recipe'],
    [NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.gdshader, 'gdshader'],
    [NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.roomBlueprint, 'room-blueprint'],
  ];

  return entries.map(([viewType, mode]) =>
    registry.registerCustomEditorProvider(
      viewType,
      createCustomEditorProvider(viewType, mode, {
        handlers,
        ...opts,
      }),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}
