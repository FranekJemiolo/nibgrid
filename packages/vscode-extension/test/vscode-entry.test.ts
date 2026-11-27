import { describe, expect, it } from 'vitest';
import { buildNibgridWebviewHtml } from '../src/vscodeEntry';

describe('buildNibgridWebviewHtml', () => {
  it('rewrites relative asset URLs, injects base href, and includes CSP header', () => {
    const html = `<!doctype html><html><head><link rel="icon" href="./icon.svg" /><script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css" /></head><body><div id="root"></div></body></html>`;
    const out = buildNibgridWebviewHtml({
      indexHtml: html,
      cspSource: 'vscode-webview://1234',
      baseUri: 'vscode-webview://1234/webview',
      toWebviewUri: (rel) => `vscode-webview://1234/webview/${rel}`,
    });

    expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(out).toContain(`img-src vscode-webview://1234 data: blob:`);
    expect(out).toContain('<base href="vscode-webview://1234/webview/">');
    expect(out).toContain('href="vscode-webview://1234/webview/icon.svg"');
    expect(out).toContain('src="vscode-webview://1234/webview/assets/index.js"');
    expect(out).toContain('href="vscode-webview://1234/webview/assets/index.css"');
  });
});
