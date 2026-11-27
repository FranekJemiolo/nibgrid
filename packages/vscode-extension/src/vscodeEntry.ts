import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateNibgridExtension,
  type VscodeExtensionContextLike,
  type VscodeHostApiLike,
} from './extension';

/**
 * Minimal structural view of the `vscode` module APIs used by this entry point.
 * (The extension core stays free of any compile-time `@types/vscode` dependency.)
 */
interface VscodeUriLike {
  readonly fsPath: string;
  toString: () => string;
}

interface VscodeWebviewLike {
  html: string;
  readonly cspSource: string;
  options: { enableScripts?: boolean; localResourceRoots?: readonly VscodeUriLike[] };
  asWebviewUri: (uri: VscodeUriLike) => VscodeUriLike;
  postMessage: (message: unknown) => PromiseLike<boolean>;
  onDidReceiveMessage: (listener: (message: unknown) => unknown) => { dispose: () => void };
}

interface VscodeWebviewPanelLike {
  readonly webview: VscodeWebviewLike;
  reveal: () => void;
  onDidDispose: (listener: () => void) => { dispose: () => void };
}

interface VscodeModuleLike {
  readonly Uri: { file: (path: string) => VscodeUriLike };
  readonly ViewColumn: { readonly One: number };
  readonly commands: {
    registerCommand: (command: string, callback: () => unknown) => { dispose: () => void };
  };
  readonly window: {
    createWebviewPanel: (
      viewType: string,
      title: string,
      column: number,
      options: {
        enableScripts: boolean;
        retainContextWhenHidden: boolean;
        localResourceRoots: readonly VscodeUriLike[];
      },
    ) => VscodeWebviewPanelLike;
    showInformationMessage: (
      message: string,
      ...items: string[]
    ) => PromiseLike<string | undefined>;
    showWarningMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
    showErrorMessage: (message: string, ...items: string[]) => PromiseLike<string | undefined>;
  };
  readonly workspace: {
    readonly workspaceFolders?: readonly { readonly uri: VscodeUriLike }[];
  };
}

interface ExtensionContextWithPath extends VscodeExtensionContextLike {
  readonly extensionPath: string;
}

/**
 * Rewrites the relative asset references of the bundled Nibgrid PWA `index.html` so they load
 * through `webview.asWebviewUri`, and injects a strict Content-Security-Policy plus `<base>`.
 */
export function buildNibgridWebviewHtml(opts: {
  readonly indexHtml: string;
  readonly cspSource: string;
  readonly toWebviewUri: (relativePath: string) => string;
  readonly baseUri?: string;
}): string {
  const rewritten = opts.indexHtml.replace(
    /(src|href)="\.\/([^"]+)"/g,
    (_match, attr: string, rel: string) => `${attr}="${opts.toWebviewUri(rel)}"`,
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${opts.cspSource} data: blob:`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src ${opts.cspSource} 'unsafe-inline'`,
    `font-src ${opts.cspSource} data:`,
    `connect-src ${opts.cspSource} https: data: blob:`,
    `worker-src ${opts.cspSource} blob:`,
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const normalizedBase = opts.baseUri
    ? opts.baseUri.endsWith('/')
      ? opts.baseUri
      : `${opts.baseUri}/`
    : undefined;
  const baseTag = normalizedBase ? `<base href="${normalizedBase}">` : '';
  const injected = baseTag ? `${meta}\n    ${baseTag}` : meta;
  return rewritten.includes('<head>')
    ? rewritten.replace('<head>', `<head>\n    ${injected}`)
    : `${injected}\n${rewritten}`;
}

/**
 * Real VS Code / Cursor / Antigravity entry point (`activate`) binding the pure-TS extension core
 * to the `vscode` module and hosting the bundled Nibgrid PWA inside a Webview panel.
 */
export function activate(context: ExtensionContextWithPath): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require('vscode') as VscodeModuleLike;

  const webviewRoot = join(context.extensionPath, 'dist', 'webview');
  let panel: VscodeWebviewPanelLike | null = null;

  const hostApi: VscodeHostApiLike = {
    registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback),
    openNibgridPanel: (onMessage) => {
      if (panel) {
        panel.reveal();
        return;
      }
      const rootUri = vscode.Uri.file(webviewRoot);
      const created = vscode.window.createWebviewPanel(
        'nibgrid.studio',
        'Nibgrid Studio',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [rootUri] },
      );
      created.webview.html = buildNibgridWebviewHtml({
        indexHtml: readFileSync(join(webviewRoot, 'index.html'), 'utf8'),
        cspSource: created.webview.cspSource,
        baseUri: created.webview.asWebviewUri(rootUri).toString(),
        toWebviewUri: (rel) =>
          created.webview.asWebviewUri(vscode.Uri.file(join(webviewRoot, rel))).toString(),
      });
      created.webview.onDidReceiveMessage(async (raw) => {
        const reply = await onMessage(raw);
        if (reply !== undefined) {
          await created.webview.postMessage(reply);
        }
      });
      created.onDidDispose(() => {
        panel = null;
      });
      panel = created;
    },
    showMessage: (level, msg, ...actions) =>
      Promise.resolve(
        level === 'error'
          ? vscode.window.showErrorMessage(msg, ...actions)
          : level === 'warn'
            ? vscode.window.showWarningMessage(msg, ...actions)
            : vscode.window.showInformationMessage(msg, ...actions),
      ),
  };

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  activateNibgridExtension(context, hostApi, {
    ...(workspacePath ? { workspacePath } : {}),
    supportsLocalProcessLaunch: true,
    detectAntigravity: async () => ({ detected: false, configDir: '' }),
    linkAntigravityMcp: async () => ({
      ok: false,
      configPath: '',
      message: 'Antigravity auto-link is available from the Models panel in the Nibgrid Studio.',
    }),
  });
}

export function deactivate(): void {
  // Disposables are tracked through `context.subscriptions`.
}
