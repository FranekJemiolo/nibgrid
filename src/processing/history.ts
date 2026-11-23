/**
 * Bounded undo/redo snapshot history for RGBA Uint8ClampedArray canvas buffers.
 * Deep-copies buffers on push and retrieval to prevent external mutation corruption.
 */
export class CanvasHistory {
  private readonly maxDepth: number;
  private snapshots: Uint8ClampedArray[] = [];
  private cursor = -1;

  constructor(initialSnapshot?: Uint8ClampedArray, maxDepth = 20) {
    if (maxDepth < 1 || !Number.isInteger(maxDepth)) {
      throw new Error(`maxDepth must be a positive integer, got ${maxDepth}`);
    }
    this.maxDepth = maxDepth;
    if (initialSnapshot) {
      this.push(initialSnapshot);
    }
  }

  push(snapshot: Uint8ClampedArray): void {
    const clone = new Uint8ClampedArray(snapshot);
    if (this.cursor < this.snapshots.length - 1) {
      this.snapshots = this.snapshots.slice(0, this.cursor + 1);
    }
    this.snapshots.push(clone);
    if (this.snapshots.length > this.maxDepth) {
      const overflow = this.snapshots.length - this.maxDepth;
      this.snapshots = this.snapshots.slice(overflow);
    }
    this.cursor = this.snapshots.length - 1;
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor >= 0 && this.cursor < this.snapshots.length - 1;
  }

  undo(): Uint8ClampedArray | null {
    if (!this.canUndo()) return null;
    this.cursor -= 1;
    return this.current();
  }

  redo(): Uint8ClampedArray | null {
    if (!this.canRedo()) return null;
    this.cursor += 1;
    return this.current();
  }

  current(): Uint8ClampedArray | null {
    const snap = this.snapshots[this.cursor];
    return snap ? new Uint8ClampedArray(snap) : null;
  }

  size(): number {
    return this.snapshots.length;
  }

  reset(initialSnapshot: Uint8ClampedArray): void {
    this.snapshots = [new Uint8ClampedArray(initialSnapshot)];
    this.cursor = 0;
  }
}
