import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M30: Zero-Server WebRTC P2P Transfer', () => {
  test('completes Offer/Answer handshake via injected RTCPeerConnection loopback, transfers .nibgrid.zip with SHA-256 verification, and imports cleanly', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Inject pure browser in-memory RTCPeerConnection loopback shim for deterministic CI testing
    await page.addInitScript(() => {
      let seq = 1;
      const peers = new Map<string, FakePeer>();

      class FakeDataChannel {
        label: string;
        binaryType: BinaryType = 'arraybuffer';
        readyState: RTCDataChannelState = 'connecting';
        bufferedAmount = 0;
        bufferedAmountLowThreshold = 65536;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: ((ev: Event) => void) | null = null;
        onbufferedamountlow: (() => void) | null = null;
        onmessage: ((ev: MessageEvent) => void) | null = null;
        remote: FakeDataChannel | null = null;

        constructor(label: string) {
          this.label = label;
        }

        markOpen() {
          if (this.readyState === 'open') return;
          this.readyState = 'open';
          queueMicrotask(() => this.onopen?.());
        }

        send(data: string | ArrayBuffer | ArrayBufferView) {
          if (this.readyState !== 'open' || !this.remote) {
            throw new Error('Loopback channel not open');
          }
          const target = this.remote;
          let payload: unknown = data;
          if (data instanceof ArrayBuffer) {
            payload = data.slice(0);
          } else if (ArrayBuffer.isView(data)) {
            const copy = new Uint8Array(data.byteLength);
            copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            payload = copy.buffer;
          }
          queueMicrotask(() => {
            if (target.readyState === 'open') {
              target.onmessage?.({ data: payload } as MessageEvent);
            }
          });
        }

        close() {
          if (this.readyState === 'closed') return;
          this.readyState = 'closed';
          this.onclose?.();
          if (this.remote && this.remote.readyState !== 'closed') {
            this.remote.readyState = 'closed';
            this.remote.onclose?.();
          }
        }
      }

      class FakePeer {
        id: string;
        iceGatheringState: RTCIceGatheringState = 'complete';
        localDescription: RTCSessionDescriptionInit | null = null;
        onicegatheringstatechange: (() => void) | null = null;
        ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
        txChannels: FakeDataChannel[] = [];
        remoteId: string | null = null;

        constructor() {
          this.id = `pw-peer-${seq++}`;
          peers.set(this.id, this);
        }

        createDataChannel(label: string) {
          const ch = new FakeDataChannel(label);
          this.txChannels.push(ch);
          return ch;
        }

        async createOffer(): Promise<RTCSessionDescriptionInit> {
          return {
            type: 'offer',
            sdp: `v=0\r\na=nibgrid-peer:${this.id}\r\n`,
          };
        }

        async createAnswer(): Promise<RTCSessionDescriptionInit> {
          return {
            type: 'answer',
            sdp: `v=0\r\na=nibgrid-peer:${this.id}\r\n`,
          };
        }

        async setLocalDescription(desc: RTCSessionDescriptionInit) {
          this.localDescription = desc;
          this.iceGatheringState = 'complete';
          queueMicrotask(() => this.onicegatheringstatechange?.());
        }

        async setRemoteDescription(desc: RTCSessionDescriptionInit) {
          const match = /a=nibgrid-peer:([^\s\r\n]+)/.exec(desc.sdp ?? '');
          if (match?.[1]) {
            this.remoteId = match[1];
          }
          if (desc.type === 'answer' && this.remoteId) {
            const receiver = peers.get(this.remoteId);
            if (receiver) {
              for (const tx of this.txChannels) {
                const rx = new FakeDataChannel(tx.label);
                tx.remote = rx;
                rx.remote = tx;
                queueMicrotask(() => {
                  rx.markOpen();
                  receiver.ondatachannel?.({ channel: rx });
                  tx.markOpen();
                });
              }
            }
          }
        }

        close() {
          for (const ch of this.txChannels) ch.close();
          peers.delete(this.id);
        }
      }

      (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeer;
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Create source project + 1 generated sprite
    await page.getByTestId('new-project-name').fill('M30 P2P Knight');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // Open Asset Vault -> Share via P2P
    await page.getByTestId('nav-asset-vault').click();
    await page.getByTestId('vault-p2p-btn').click();
    await expect(page.getByTestId('p2p-transfer-modal')).toBeVisible();

    // 1. Send Tab: Create Offer
    await page.getByTestId('p2p-create-offer-btn').click();
    await expect(page.getByTestId('p2p-offer-code')).toBeVisible();
    await expect(page.getByTestId('p2p-qr-svg')).toBeVisible();
    const offerCode = await page.getByTestId('p2p-offer-code').inputValue();
    expect(offerCode.startsWith('NIB-O1:')).toBe(true);

    // 2. Receive Tab: Paste Offer -> Generate Answer
    await page.getByTestId('p2p-tab-receive').click();
    await page.getByTestId('p2p-offer-input').fill(offerCode);
    await page.getByTestId('p2p-create-answer-btn').click();
    await expect(page.getByTestId('p2p-answer-code')).toBeVisible();
    const answerCode = await page.getByTestId('p2p-answer-code').inputValue();
    expect(answerCode.startsWith('NIB-A1:')).toBe(true);

    // 3. Send Tab: Accept Answer & Stream Snapshot -> assert 100% + SHA-256 Verified
    await page.getByTestId('p2p-tab-send').click();
    await page.getByTestId('p2p-answer-input').fill(answerCode);
    await page.getByTestId('p2p-accept-answer-btn').click();
    await expect(page.getByTestId('p2p-send-progress')).toContainText('100%');
    await expect(page.getByTestId('p2p-send-verified')).toBeVisible();

    // 4. Receive Tab: Assert 100% + SHA-256 Verified -> 1-click Import into Nibgrid
    await page.getByTestId('p2p-tab-receive').click();
    await expect(page.getByTestId('p2p-recv-progress')).toContainText('100%');
    await expect(page.getByTestId('p2p-recv-verified')).toBeVisible();

    await page.getByTestId('p2p-import-btn').click();
    await expect(page.getByTestId('p2p-transfer-modal')).toBeHidden();
    await expect(page.getByTestId('vault-browser-view')).toBeVisible();
    // Source project had 1 sketch + 1 generated sprite node (2 total)
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(2);

    // Confirm imported project appears in Projects Hub cleanly across reload
    await page.reload();
    await page.getByTestId('nav-projects').click();
    await expect(page.locator('article', { hasText: 'M30 P2P Knight (Imported)' })).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
