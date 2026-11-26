import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  Copy,
  Radio,
  ShieldCheck,
  X,
} from 'lucide-react';
import { db } from '../../db/database';
import type { P2pProgress, P2pVerifyResult } from '../../p2p/p2pProtocol';
import {
  DEFAULT_ICE_SERVERS,
  P2pReceiverSession,
  P2pSenderSession,
  defaultPeerConnectionFactory,
} from '../../p2p/webrtcTransfer';
import { useAppStore } from '../../store/useAppStore';
import { exportProjectSnapshotFromDb, importProjectSnapshotToDb } from '../../sync/projectSnapshot';

interface P2pTransferModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Renders a deterministic finder-patterned 29x29 visual QR matrix for compact `NIB-O1:` / `NIB-A1:` codes.
 */
function buildVisualQrCells(payload: string): boolean[][] {
  const size = 29;
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const drawFinder = (top: number, left: number) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[top + r]![left + c] = border || inner;
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0 || 1;
  const nextBit = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) & 1) === 1;
  };

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= size - 8;
      const inBotLeft = r >= size - 8 && c < 8;
      if (inTopLeft || inTopRight || inBotLeft) continue;
      if (r === 6 || c === 6) {
        grid[r]![c] = (r + c) % 2 === 0;
        continue;
      }
      grid[r]![c] = nextBit();
    }
  }
  return grid;
}

function SdpQrCodeSvg({ value, label }: { readonly value: string; readonly label: string }) {
  const cells = useMemo(() => buildVisualQrCells(value), [value]);
  const size = cells.length;
  return (
    <svg
      data-testid="p2p-qr-svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size + 2} ${size + 2}`}
      className="h-28 w-28 shrink-0 rounded border border-[#2A2A2E] bg-white p-1"
    >
      <rect width={size + 2} height={size + 2} fill="#FFFFFF" />
      {cells.map((row, r) =>
        row.map((on, c) =>
          on ? (
            <rect key={`${r}-${c}`} x={c + 1} y={r + 1} width={1} height={1} fill="#121214" />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function P2pTransferModal({ open, onClose }: P2pTransferModalProps) {
  const { projects, activeProject, refreshProjects, navigate } = useAppStore();

  const [tab, setTab] = useState<'send' | 'receive'>('send');
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => activeProject?.id ?? projects[0]?.project.id ?? '',
  );

  // Send state
  const [offerCode, setOfferCode] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [sendPercent, setSendPercent] = useState(0);
  const [sendSha256, setSendSha256] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Receive state
  const [offerInput, setOfferInput] = useState('');
  const [answerCode, setAnswerCode] = useState('');
  const [recvProgress, setRecvProgress] = useState<P2pProgress | null>(null);
  const [recvVerified, setRecvVerified] = useState<Extract<P2pVerifyResult, { ok: true }> | null>(
    null,
  );
  const [recvBusy, setRecvBusy] = useState(false);
  const [recvError, setRecvError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const senderSessionRef = useRef<P2pSenderSession | null>(null);
  const receiverSessionRef = useRef<P2pReceiverSession | null>(null);
  const packedSnapshotRef = useRef<{ filename: string; bytes: Uint8Array } | null>(null);

  useEffect(() => {
    if (activeProject?.id) {
      setSelectedProjectId(activeProject.id);
    } else if (!selectedProjectId && projects[0]?.project.id) {
      setSelectedProjectId(projects[0].project.id);
    }
  }, [activeProject?.id, projects, selectedProjectId]);

  useEffect(() => {
    if (!open) {
      senderSessionRef.current?.dispose();
      senderSessionRef.current = null;
      receiverSessionRef.current?.dispose();
      receiverSessionRef.current = null;
      packedSnapshotRef.current = null;
    }
    return () => {
      senderSessionRef.current?.dispose();
      senderSessionRef.current = null;
      receiverSessionRef.current?.dispose();
      receiverSessionRef.current = null;
      packedSnapshotRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const copyText = async (key: string, text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setCopiedKey(key);
    }
  };

  const handleCreateOffer = async () => {
    const targetId = selectedProjectId || activeProject?.id || projects[0]?.project.id;
    if (!targetId) {
      setSendError('Create a project first before starting a P2P transfer.');
      return;
    }
    setSendBusy(true);
    setSendError(null);
    setSendSha256(null);
    setSendPercent(0);
    senderSessionRef.current?.dispose();

    try {
      const packed = await exportProjectSnapshotFromDb(db, targetId);
      packedSnapshotRef.current = packed;

      const sender = new P2pSenderSession(defaultPeerConnectionFactory, DEFAULT_ICE_SERVERS);
      senderSessionRef.current = sender;
      const code = await sender.createOffer();
      setOfferCode(code);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to create WebRTC Offer.');
    } finally {
      setSendBusy(false);
    }
  };

  const handleAcceptAnswerAndSend = async () => {
    const sender = senderSessionRef.current;
    const packed = packedSnapshotRef.current;
    if (!sender || !packed) {
      setSendError('Create an Offer first.');
      return;
    }
    if (!answerInput.trim()) {
      setSendError('Paste the Receiver Answer code (NIB-A1:...).');
      return;
    }
    setSendBusy(true);
    setSendError(null);
    setSendSha256(null);

    try {
      const res = await sender.acceptAnswerAndSend(answerInput.trim(), {
        filename: packed.filename,
        bytes: packed.bytes,
        onProgress: ({ percent }) => setSendPercent(percent),
      });
      setSendPercent(100);
      setSendSha256(res.sha256Hex);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'P2P transfer failed.');
    } finally {
      setSendBusy(false);
    }
  };

  const handleCreateAnswer = async () => {
    if (!offerInput.trim()) {
      setRecvError('Paste a Sender Offer code (NIB-O1:...) first.');
      return;
    }
    setRecvBusy(true);
    setRecvError(null);
    setRecvVerified(null);
    setRecvProgress(null);
    setImportNotice(null);
    receiverSessionRef.current?.dispose();

    try {
      const receiver = new P2pReceiverSession(defaultPeerConnectionFactory, DEFAULT_ICE_SERVERS, {
        onProgress: (prog) => setRecvProgress(prog),
        onVerified: (verified) => setRecvVerified(verified),
        onError: (reason) => setRecvError(reason),
      });
      receiverSessionRef.current = receiver;
      const code = await receiver.acceptOfferAndCreateAnswer(offerInput.trim());
      setAnswerCode(code);
    } catch (err) {
      setRecvError(err instanceof Error ? err.message : 'Failed to generate WebRTC Answer.');
    } finally {
      setRecvBusy(false);
    }
  };

  const handleImportReceived = async () => {
    if (!recvVerified) return;
    setRecvBusy(true);
    setRecvError(null);
    try {
      const imported = await importProjectSnapshotToDb(db, recvVerified.bytes);
      await refreshProjects();
      setImportNotice(
        `Imported "${imported.project.name}" (${imported.spriteCount} sprites, ${imported.audioCount} audio).`,
      );
      onClose();
      await navigate({ screen: 'vault', projectId: imported.project.id });
    } catch (err) {
      setRecvError(err instanceof Error ? err.message : 'Failed to import P2P snapshot.');
    } finally {
      setRecvBusy(false);
    }
  };

  return (
    <div
      data-testid="p2p-transfer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2A2A2E] bg-[#1A1A1D] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2A2A2E] px-5 py-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                Zero-Server WebRTC P2P Direct Transfer
              </h3>
              <p className="text-[11px] text-zinc-400">
                Direct browser-to-browser DataChannel (`16 KiB` chunks + SHA-256 verification).
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="p2p-close-btn"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switch */}
        <div className="flex gap-2 border-b border-[#2A2A2E] bg-[#121214] px-5 py-2">
          <button
            type="button"
            data-testid="p2p-tab-send"
            onClick={() => setTab('send')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'send' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-300 hover:text-white'
            }`}
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Send Snapshot (.nibgrid.zip)
          </button>
          <button
            type="button"
            data-testid="p2p-tab-receive"
            onClick={() => setTab('receive')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'receive' ? 'bg-amber-500 text-zinc-950' : 'text-zinc-300 hover:text-white'
            }`}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Receive Snapshot
          </button>
        </div>

        <div className="overflow-y-auto p-5">
          {/* SEND PANEL (stays mounted cleanly when switching tabs) */}
          <div className={tab === 'send' ? 'space-y-4' : 'hidden'}>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium text-zinc-300">
                Project:
                <select
                  data-testid="p2p-project-select"
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="ml-2 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-xs text-zinc-100"
                >
                  {projects.map(({ project }) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={sendBusy || projects.length === 0}
                data-testid="p2p-create-offer-btn"
                onClick={() => void handleCreateOffer()}
                className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                Create Offer (`NIB-O1`)
              </button>
            </div>

            {offerCode && (
              <div className="flex flex-col gap-3 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3 sm:flex-row">
                <SdpQrCodeSvg value={offerCode} label="WebRTC Offer QR Code" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>1. Send this Offer to Receiver (`NIB-O1:`):</span>
                    <button
                      type="button"
                      onClick={() => void copyText('offer', offerCode)}
                      className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] px-2 py-0.5 text-zinc-200 hover:border-zinc-500"
                    >
                      {copiedKey === 'offer' ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedKey === 'offer' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    rows={3}
                    data-testid="p2p-offer-code"
                    value={offerCode}
                    className="w-full resize-none rounded border border-[#2A2A2E] bg-[#1A1A1D] p-2 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3">
              <label
                htmlFor="p2p-answer-input"
                className="block text-[11px] font-medium text-zinc-300"
              >
                2. Paste Receiver Answer (`NIB-A1:...`):
              </label>
              <textarea
                id="p2p-answer-input"
                rows={3}
                data-testid="p2p-answer-input"
                value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                placeholder="NIB-A1:..."
                className="w-full resize-none rounded border border-[#2A2A2E] bg-[#1A1A1D] p-2 font-mono text-[11px] text-zinc-100"
              />
              <button
                type="button"
                disabled={sendBusy || !offerCode}
                data-testid="p2p-accept-answer-btn"
                onClick={() => void handleAcceptAnswerAndSend()}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                Connect &amp; Send Snapshot
              </button>
            </div>

            {(sendPercent > 0 || sendSha256) && (
              <div className="space-y-2 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3">
                <div className="flex items-center justify-between text-xs">
                  <span data-testid="p2p-send-progress" className="font-mono text-zinc-200">
                    Sent: {sendPercent}%
                  </span>
                  {sendSha256 && (
                    <span
                      data-testid="p2p-send-verified"
                      className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      SHA-256 Verified ({sendSha256.slice(0, 12)}…)
                    </span>
                  )}
                </div>
                <div className="h-2 overflow-hidden rounded bg-[#2A2A2E]">
                  <div
                    className="h-full bg-amber-400 transition-all"
                    style={{ width: `${sendPercent}%` }}
                  />
                </div>
              </div>
            )}

            {sendError && (
              <p
                data-testid="p2p-send-error"
                className="rounded border border-rose-500/40 bg-rose-950/35 p-2.5 text-xs text-rose-200"
              >
                {sendError}
              </p>
            )}
          </div>

          {/* RECEIVE PANEL (stays mounted cleanly when switching tabs) */}
          <div className={tab === 'receive' ? 'space-y-4' : 'hidden'}>
            <div className="space-y-2 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3">
              <label
                htmlFor="p2p-offer-input"
                className="block text-[11px] font-medium text-zinc-300"
              >
                1. Paste Sender Offer (`NIB-O1:...`):
              </label>
              <textarea
                id="p2p-offer-input"
                rows={3}
                data-testid="p2p-offer-input"
                value={offerInput}
                onChange={(e) => setOfferInput(e.target.value)}
                placeholder="NIB-O1:..."
                className="w-full resize-none rounded border border-[#2A2A2E] bg-[#1A1A1D] p-2 font-mono text-[11px] text-zinc-100"
              />
              <button
                type="button"
                disabled={recvBusy}
                data-testid="p2p-create-answer-btn"
                onClick={() => void handleCreateAnswer()}
                className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                Generate Answer (`NIB-A1`)
              </button>
            </div>

            {answerCode && (
              <div className="flex flex-col gap-3 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3 sm:flex-row">
                <SdpQrCodeSvg value={answerCode} label="WebRTC Answer QR Code" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>2. Send this Answer back to Sender (`NIB-A1:`):</span>
                    <button
                      type="button"
                      onClick={() => void copyText('answer', answerCode)}
                      className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] px-2 py-0.5 text-zinc-200 hover:border-zinc-500"
                    >
                      {copiedKey === 'answer' ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedKey === 'answer' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    rows={3}
                    data-testid="p2p-answer-code"
                    value={answerCode}
                    className="w-full resize-none rounded border border-[#2A2A2E] bg-[#1A1A1D] p-2 font-mono text-[10px] text-zinc-200"
                  />
                </div>
              </div>
            )}

            {(recvProgress || recvVerified) && (
              <div className="space-y-3 rounded-lg border border-[#2A2A2E] bg-[#121214] p-3">
                <div className="flex items-center justify-between text-xs">
                  <span data-testid="p2p-recv-progress" className="font-mono text-zinc-200">
                    Received: {recvVerified ? 100 : (recvProgress?.percent ?? 0)}%
                  </span>
                  {recvVerified && (
                    <span
                      data-testid="p2p-recv-verified"
                      className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      SHA-256 Verified ({recvVerified.sha256Hex.slice(0, 12)}…)
                    </span>
                  )}
                </div>
                <div className="h-2 overflow-hidden rounded bg-[#2A2A2E]">
                  <div
                    className="h-full bg-emerald-400 transition-all"
                    style={{ width: `${recvVerified ? 100 : (recvProgress?.percent ?? 0)}%` }}
                  />
                </div>
                {recvVerified && (
                  <div className="flex items-center justify-between pt-1">
                    <span className="font-mono text-[11px] text-zinc-400">
                      {recvVerified.filename} ({recvVerified.bytes.byteLength} bytes)
                    </span>
                    <button
                      type="button"
                      disabled={recvBusy}
                      data-testid="p2p-import-btn"
                      onClick={() => void handleImportReceived()}
                      className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Import into Nibgrid
                    </button>
                  </div>
                )}
              </div>
            )}

            {importNotice && (
              <p className="rounded border border-emerald-500/40 bg-emerald-950/30 p-2.5 text-xs text-emerald-200">
                {importNotice}
              </p>
            )}
            {recvError && (
              <p
                data-testid="p2p-recv-error"
                className="rounded border border-rose-500/40 bg-rose-950/35 p-2.5 text-xs text-rose-200"
              >
                {recvError}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
