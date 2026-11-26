import { sha256Bytes } from '../processing/hash';
import {
  P2P_CHUNK_BYTES,
  P2pControlMessageSchema,
  P2pReassembler,
  slicePayloadIntoFrames,
  type P2pControlMessage,
  type P2pProgress,
  type P2pVerifyResult,
} from './p2pProtocol';
import { decodeSdp, encodeSdp } from './sdpCodec';

export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export const DATA_CHANNEL_LABEL = 'nibgrid-transfer';
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 65536;
export const ICE_GATHER_TIMEOUT_MS = 3000;

export interface PeerDataChannelLike {
  readonly label: string;
  binaryType: BinaryType;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
  onbufferedamountlow: (() => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

export interface PeerConnectionLike {
  readonly iceGatheringState: RTCIceGatheringState;
  readonly localDescription: RTCSessionDescriptionInit | null;
  onicegatheringstatechange: (() => void) | null;
  ondatachannel: ((ev: { channel: PeerDataChannelLike }) => void) | null;
  createDataChannel(label: string, options?: RTCDataChannelInit): PeerDataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

export type PeerConnectionFactory = (iceServers: readonly RTCIceServer[]) => PeerConnectionLike;

export function defaultPeerConnectionFactory(
  iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS,
): PeerConnectionLike {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('WebRTC RTCPeerConnection is unavailable in this environment.');
  }
  return new RTCPeerConnection({
    iceServers: [...iceServers],
  }) as unknown as PeerConnectionLike;
}

/**
 * Pure-TS in-memory loopback factory wiring two `PeerConnectionLike` instances directly
 * via encoded SDP peer IDs so Vitest & offline flows exercise full Offer/Answer/DataChannel
 * chunking and SHA-256 verification without network sockets.
 */
export function createInMemoryLoopbackPeerFactory(): PeerConnectionFactory {
  let nextId = 1;
  const peers = new Map<string, LoopbackPeerConnection>();

  class LoopbackDataChannel implements PeerDataChannelLike {
    readonly label: string;
    binaryType: BinaryType = 'arraybuffer';
    readyState: RTCDataChannelState = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onbufferedamountlow: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    peerChannel: LoopbackDataChannel | null = null;

    constructor(label: string) {
      this.label = label;
    }

    openBoth(): void {
      if (this.readyState === 'open') return;
      this.readyState = 'open';
      queueMicrotask(() => this.onopen?.());
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this.readyState !== 'open' || !this.peerChannel) {
        throw new Error('Loopback DataChannel is not open.');
      }
      const target = this.peerChannel;
      let delivered: unknown = data;
      if (data instanceof ArrayBuffer) {
        delivered = data.slice(0);
      } else if (ArrayBuffer.isView(data)) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        delivered = copy.buffer;
      }
      queueMicrotask(() => {
        if (target.readyState === 'open') {
          target.onmessage?.({ data: delivered } as MessageEvent);
        }
      });
    }

    close(): void {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      this.onclose?.();
      if (this.peerChannel && this.peerChannel.readyState !== 'closed') {
        this.peerChannel.readyState = 'closed';
        this.peerChannel.onclose?.();
      }
    }
  }

  class LoopbackPeerConnection implements PeerConnectionLike {
    readonly peerId: string;
    iceGatheringState: RTCIceGatheringState = 'complete';
    localDescription: RTCSessionDescriptionInit | null = null;
    onicegatheringstatechange: (() => void) | null = null;
    ondatachannel: ((ev: { channel: PeerDataChannelLike }) => void) | null = null;
    private outboundChannels: LoopbackDataChannel[] = [];
    private remotePeerId: string | null = null;

    constructor() {
      this.peerId = `loopback-${nextId++}`;
      peers.set(this.peerId, this);
    }

    createDataChannel(label: string): PeerDataChannelLike {
      const ch = new LoopbackDataChannel(label);
      this.outboundChannels.push(ch);
      return ch;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return {
        type: 'offer',
        sdp: `v=0\r\na=nibgrid-peer:${this.peerId}\r\n`,
      };
    }

    async createAnswer(): Promise<RTCSessionDescriptionInit> {
      return {
        type: 'answer',
        sdp: `v=0\r\na=nibgrid-peer:${this.peerId}\r\n`,
      };
    }

    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = description;
      this.iceGatheringState = 'complete';
      queueMicrotask(() => this.onicegatheringstatechange?.());
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      const match = /a=nibgrid-peer:([^\s\r\n]+)/.exec(description.sdp ?? '');
      if (match?.[1]) {
        this.remotePeerId = match[1];
      }
      if (description.type === 'answer' && this.remotePeerId) {
        const receiver = peers.get(this.remotePeerId);
        if (receiver) {
          for (const tx of this.outboundChannels) {
            const rx = new LoopbackDataChannel(tx.label);
            tx.peerChannel = rx;
            rx.peerChannel = tx;
            queueMicrotask(() => {
              rx.openBoth();
              receiver.ondatachannel?.({ channel: rx });
              tx.openBoth();
            });
          }
        }
      }
    }

    close(): void {
      for (const ch of this.outboundChannels) {
        ch.close();
      }
      peers.delete(this.peerId);
    }
  }

  return () => new LoopbackPeerConnection();
}

async function waitForIceGatheringComplete(
  pc: PeerConnectionLike,
  timeoutMs = ICE_GATHER_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const prev = pc.onicegatheringstatechange;
    pc.onicegatheringstatechange = () => {
      prev?.();
      if (pc.iceGatheringState === 'complete') {
        done();
      }
    };
    setTimeout(done, timeoutMs);
  });
}

async function waitForDataChannelOpen(dc: PeerDataChannelLike, timeoutMs = 15000): Promise<void> {
  if (dc.readyState === 'open') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebRTC DataChannel to open.'));
    }, timeoutMs);
    const prevOpen = dc.onopen;
    const prevErr = dc.onerror;
    dc.onopen = () => {
      clearTimeout(timer);
      prevOpen?.();
      resolve();
    };
    dc.onerror = (ev) => {
      clearTimeout(timer);
      prevErr?.(ev);
      reject(new Error('WebRTC DataChannel failed before opening.'));
    };
  });
}

async function drainBackpressure(dc: PeerDataChannelLike): Promise<void> {
  if (dc.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const prev = dc.onbufferedamountlow;
    dc.onbufferedamountlow = () => {
      prev?.();
      finish();
    };
    setTimeout(finish, 250);
  });
}

function toUint8(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export class P2pSenderSession {
  private readonly pc: PeerConnectionLike;
  private dc: PeerDataChannelLike | null = null;
  private disposed = false;

  constructor(
    factory: PeerConnectionFactory = defaultPeerConnectionFactory,
    iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS,
  ) {
    this.pc = factory(iceServers);
  }

  async createOffer(): Promise<string> {
    if (this.disposed) throw new Error('Sender session already disposed.');
    const dc = this.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    this.dc = dc;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.pc);

    const finalDesc = this.pc.localDescription ?? offer;
    return encodeSdp({ type: finalDesc.type ?? 'offer', sdp: finalDesc.sdp ?? '' });
  }

  async acceptAnswerAndSend(
    answerCode: string,
    payload: {
      readonly filename: string;
      readonly bytes: Uint8Array;
      readonly chunkSize?: number;
      readonly onProgress?: (progress: {
        readonly sentChunks: number;
        readonly totalChunks: number;
        readonly percent: number;
      }) => void;
    },
  ): Promise<{ readonly sha256Hex: string }> {
    if (this.disposed) throw new Error('Sender session already disposed.');
    const decoded = decodeSdp(answerCode);
    if (!decoded.ok || decoded.description.type !== 'answer') {
      throw new Error(decoded.ok ? 'Expected Answer code (NIB-A1:).' : decoded.error);
    }

    const dc = this.dc;
    if (!dc) {
      throw new Error('Offer must be created before accepting an Answer.');
    }

    const ackPromise = new Promise<void>((resolve, reject) => {
      dc.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const parsed = P2pControlMessageSchema.parse(JSON.parse(ev.data)) as P2pControlMessage;
          if (parsed.type === 'ACK') {
            if (parsed.verified) resolve();
            else reject(new Error('Receiver reported failed SHA-256 verification.'));
          } else if (parsed.type === 'ERROR') {
            reject(new Error(`Receiver error: ${parsed.reason}`));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Malformed receiver ACK packet.'));
        }
      };
    });

    await this.pc.setRemoteDescription(decoded.description);
    await waitForDataChannelOpen(dc);

    const sha256Hex = await sha256Bytes(payload.bytes);
    const frames = slicePayloadIntoFrames(payload.bytes, payload.chunkSize ?? P2P_CHUNK_BYTES);

    const metaMsg: P2pControlMessage = {
      type: 'META',
      filename: payload.filename,
      totalBytes: payload.bytes.byteLength,
      totalChunks: frames.length,
      sha256Hex,
    };
    dc.send(JSON.stringify(metaMsg));

    for (let i = 0; i < frames.length; i += 1) {
      if (this.disposed) throw new Error('Transfer cancelled.');
      await drainBackpressure(dc);
      const frame = frames[i]!;
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      dc.send(copy.buffer);
      payload.onProgress?.({
        sentChunks: i + 1,
        totalChunks: frames.length,
        percent: Math.min(100, Math.round(((i + 1) / frames.length) * 100)),
      });
    }

    const completeMsg: P2pControlMessage = {
      type: 'COMPLETE',
      sha256Hex,
    };
    dc.send(JSON.stringify(completeMsg));

    await ackPromise;
    return { sha256Hex };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dc?.close();
    this.pc.close();
  }
}

export class P2pReceiverSession {
  private readonly pc: PeerConnectionLike;
  private readonly reassembler = new P2pReassembler();
  private dc: PeerDataChannelLike | null = null;
  private disposed = false;

  constructor(
    factory: PeerConnectionFactory = defaultPeerConnectionFactory,
    iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS,
    private readonly handlers?: {
      readonly onProgress?: (progress: P2pProgress) => void;
      readonly onVerified?: (result: Extract<P2pVerifyResult, { ok: true }>) => void;
      readonly onError?: (reason: string) => void;
    },
  ) {
    this.pc = factory(iceServers);
    this.pc.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      this.dc = channel;
      channel.onmessage = (ev) => {
        void this.handleIncomingMessage(channel, ev.data);
      };
    };
  }

  private async handleIncomingMessage(channel: PeerDataChannelLike, data: unknown): Promise<void> {
    if (this.disposed) return;
    try {
      if (typeof data === 'string') {
        const msg = P2pControlMessageSchema.parse(JSON.parse(data)) as P2pControlMessage;
        if (msg.type === 'META') {
          this.reassembler.acceptMeta(msg);
          this.handlers?.onProgress?.(this.reassembler.getProgress());
        } else if (msg.type === 'COMPLETE') {
          const verified = await this.reassembler.finalizeAndVerify(msg.sha256Hex);
          if (verified.ok) {
            channel.send(
              JSON.stringify({ type: 'ACK', verified: true } satisfies P2pControlMessage),
            );
            this.handlers?.onVerified?.(verified);
          } else {
            channel.send(
              JSON.stringify({
                type: 'ERROR',
                reason: verified.reason,
              } satisfies P2pControlMessage),
            );
            this.handlers?.onError?.(verified.reason);
          }
        }
        return;
      }

      const bin = toUint8(data);
      if (bin) {
        const prog = this.reassembler.ingestFrame(bin);
        this.handlers?.onProgress?.(prog);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unexpected P2P receiver error.';
      try {
        channel.send(JSON.stringify({ type: 'ERROR', reason } satisfies P2pControlMessage));
      } catch {
        // ignore closed channel
      }
      this.handlers?.onError?.(reason);
    }
  }

  async acceptOfferAndCreateAnswer(offerCode: string): Promise<string> {
    if (this.disposed) throw new Error('Receiver session already disposed.');
    const decoded = decodeSdp(offerCode);
    if (!decoded.ok || decoded.description.type !== 'offer') {
      throw new Error(decoded.ok ? 'Expected Offer code (NIB-O1:).' : decoded.error);
    }

    await this.pc.setRemoteDescription(decoded.description);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(this.pc);

    const finalDesc = this.pc.localDescription ?? answer;
    return encodeSdp({ type: finalDesc.type ?? 'answer', sdp: finalDesc.sdp ?? '' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dc?.close();
    this.pc.close();
  }
}
