import { describe, expect, it } from 'vitest';
import {
  P2P_CHUNK_BYTES,
  P2pReassembler,
  decodeChunkFrame,
  slicePayloadIntoFrames,
} from '../../src/p2p/p2pProtocol';
import { SDP_ANSWER_PREFIX, SDP_OFFER_PREFIX, decodeSdp, encodeSdp } from '../../src/p2p/sdpCodec';
import {
  P2pReceiverSession,
  P2pSenderSession,
  createInMemoryLoopbackPeerFactory,
} from '../../src/p2p/webrtcTransfer';
import { sha256Bytes } from '../../src/processing/hash';

describe('M30 WebRTC P2P Binary Protocol, SDP Codec & Loopback Transfer', () => {
  it('chunks and reassembles 100 KiB payload with byte-identical SHA-256 verification', async () => {
    const payload = new Uint8Array(100 * 1024);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 31 + 7) & 0xff;
    }
    const sha256Hex = await sha256Bytes(payload);
    const frames = slicePayloadIntoFrames(payload, P2P_CHUNK_BYTES);
    expect(frames.length).toBe(Math.ceil(payload.length / P2P_CHUNK_BYTES));
    expect(frames.length).toBe(7);

    // Check 4-byte chunk index headers
    expect(decodeChunkFrame(frames[0]!).chunkIndex).toBe(0);
    expect(decodeChunkFrame(frames[3]!).chunkIndex).toBe(3);

    const reassembler = new P2pReassembler();
    reassembler.acceptMeta({
      type: 'META',
      filename: 'crypt-knight.nibgrid.zip',
      totalBytes: payload.byteLength,
      totalChunks: frames.length,
      sha256Hex,
    });

    for (const frame of frames) {
      reassembler.ingestFrame(frame);
    }

    const verified = await reassembler.finalizeAndVerify(sha256Hex);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.sha256Hex).toBe(sha256Hex);
      expect(verified.bytes).toEqual(payload);
    }

    // Flip 1 bit in chunk 3 -> fails SHA-256 verification cleanly with ok: false
    const badReassembler = new P2pReassembler();
    badReassembler.acceptMeta({
      type: 'META',
      filename: 'crypt-knight.nibgrid.zip',
      totalBytes: payload.byteLength,
      totalChunks: frames.length,
      sha256Hex,
    });

    for (let i = 0; i < frames.length; i += 1) {
      const f = new Uint8Array(frames[i]!);
      if (i === 3) {
        f[10] = (f[10]! ^ 0x01) & 0xff;
      }
      badReassembler.ingestFrame(f);
    }

    const corruptResult = await badReassembler.finalizeAndVerify(sha256Hex);
    expect(corruptResult.ok).toBe(false);
    if (!corruptResult.ok) {
      expect(corruptResult.reason).toMatch(/SHA-256 verification failed/i);
    }
  });

  it('compresses and round-trips Offer and Answer SDP codes while rejecting invalid prefixes', () => {
    const offerSdp =
      'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
    const answerSdp =
      'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

    const offerCode = encodeSdp({ type: 'offer', sdp: offerSdp });
    const answerCode = encodeSdp({ type: 'answer', sdp: answerSdp });

    expect(offerCode.startsWith(SDP_OFFER_PREFIX)).toBe(true);
    expect(answerCode.startsWith(SDP_ANSWER_PREFIX)).toBe(true);

    const decodedOffer = decodeSdp(offerCode);
    expect(decodedOffer.ok).toBe(true);
    if (decodedOffer.ok) {
      expect(decodedOffer.description.type).toBe('offer');
      expect(decodedOffer.description.sdp).toBe(offerSdp);
    }

    const decodedAnswer = decodeSdp(answerCode);
    expect(decodedAnswer.ok).toBe(true);
    if (decodedAnswer.ok) {
      expect(decodedAnswer.description.type).toBe('answer');
      expect(decodedAnswer.description.sdp).toBe(answerSdp);
    }

    expect(decodeSdp('BAD-PREFIX:abc').ok).toBe(false);
    expect(decodeSdp(`${SDP_OFFER_PREFIX}%%%`).ok).toBe(false);
  });

  it('transfers 100 KiB payload end-to-end across in-memory loopback P2pSenderSession <-> P2pReceiverSession', async () => {
    const factory = createInMemoryLoopbackPeerFactory();
    const payload = new Uint8Array(100 * 1024);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 17 + 3) & 0xff;
    }

    let verifiedBytes: Uint8Array | null = null;
    let verifiedSha = '';
    const sender = new P2pSenderSession(factory, []);
    const receiver = new P2pReceiverSession(factory, [], {
      onVerified: (res) => {
        verifiedBytes = res.bytes;
        verifiedSha = res.sha256Hex;
      },
    });

    try {
      const offerCode = await sender.createOffer();
      const answerCode = await receiver.acceptOfferAndCreateAnswer(offerCode);
      const sendResult = await sender.acceptAnswerAndSend(answerCode, {
        filename: 'loopback-project.nibgrid.zip',
        bytes: payload,
      });

      expect(verifiedBytes).not.toBeNull();
      expect(verifiedSha).toBe(sendResult.sha256Hex);
      expect(verifiedBytes!).toEqual(payload);
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });
});
