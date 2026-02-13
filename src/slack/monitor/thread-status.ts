import { logVerbose } from "../../globals.js";

export type ThreadStatusHandle = {
  setStatus: (text: string) => void;
  release: () => void;
};

type ThreadStatusManagerParams = {
  key: string;
  push: (status: string) => Promise<void>;
  pushIntervalMs: number;
  graceMs: number;
  graceText: string;
  onError?: (err: unknown) => void;
};

// Module-level Map — one manager per channel+thread.
const managers = new Map<string, ThreadStatusManager>();

/**
 * For testing: clears all managers (stops loops, cancels grace timers).
 * @internal
 */
export function _resetAllManagers(): void {
  for (const mgr of managers.values()) {
    mgr.forceDestroy();
  }
  managers.clear();
}

/**
 * Acquire a shared status handle for a Slack thread.
 *
 * Multiple dispatches targeting the same thread share one push loop,
 * preventing status blinks between sequential dispatches.
 */
export function acquireThreadStatus(params: {
  key: string;
  push: (status: string) => Promise<void>;
  pushIntervalMs?: number;
  graceMs?: number;
  graceText?: string;
  shouldGrace?: () => boolean;
  onError?: (err: unknown) => void;
}): ThreadStatusHandle {
  const {
    key,
    push,
    pushIntervalMs = 100,
    graceMs = 5_000,
    graceText = "is thinking...",
    shouldGrace,
    onError,
  } = params;

  let mgr = managers.get(key);
  if (!mgr) {
    mgr = new ThreadStatusManager({
      key,
      push,
      pushIntervalMs,
      graceMs,
      graceText,
      onError,
    });
    managers.set(key, mgr);
  }
  return mgr.acquire(shouldGrace);
}

class ThreadStatusManager {
  private currentText = "";
  private activeHandles = 0;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;

  private readonly key: string;
  private readonly pushFn: (status: string) => Promise<void>;
  private readonly pushIntervalMs: number;
  private readonly graceMs: number;
  private readonly graceText: string;
  private readonly onError?: (err: unknown) => void;

  constructor(params: ThreadStatusManagerParams) {
    this.key = params.key;
    this.pushFn = params.push;
    this.pushIntervalMs = params.pushIntervalMs;
    this.graceMs = params.graceMs;
    this.graceText = params.graceText;
    this.onError = params.onError;
  }

  acquire(shouldGrace?: () => boolean): ThreadStatusHandle {
    this.activeHandles++;
    this.cancelGrace();
    logVerbose(`[thread-status] acquire: key=${this.key} handles=${this.activeHandles}`);

    let released = false;
    return {
      setStatus: (text: string) => {
        if (released) {
          return;
        }
        if (text !== this.currentText) {
          logVerbose(`[thread-status] setStatus: key=${this.key} text="${text}"`);
        }
        this.currentText = text;
        if (text && !this.pushTimer) {
          this.startPushLoop();
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseHandle(shouldGrace);
      },
    };
  }

  /** Force-stop everything (for testing). */
  forceDestroy(): void {
    this.cancelGrace();
    this.stopLoop();
  }

  private releaseHandle(shouldGrace?: () => boolean): void {
    this.activeHandles = Math.max(0, this.activeHandles - 1);
    const graceResult = shouldGrace ? shouldGrace() : undefined;
    logVerbose(
      `[thread-status] release: key=${this.key} handles=${this.activeHandles} shouldGrace=${graceResult ?? "n/a"}`,
    );
    if (this.activeHandles > 0) {
      return;
    }

    if (!this.pushTimer) {
      // Push loop never started (e.g. typingMode=never) — just destroy.
      this.destroy();
      return;
    }

    // If the caller signals that no more dispatches are pending, skip grace
    // and clear the status immediately.
    if (graceResult === false) {
      logVerbose(`[thread-status] shouldGrace skip (immediate clear): key=${this.key}`);
      this.currentText = "";
      void this.pushOnce("").finally(() => this.stopAndDestroy());
      return;
    }

    // Grace period: keep pushing graceText, then clear.
    logVerbose(`[thread-status] grace start: key=${this.key} graceMs=${this.graceMs}`);
    this.currentText = this.graceText;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      logVerbose(`[thread-status] grace end (clear): key=${this.key}`);
      this.currentText = "";
      void this.pushOnce("").finally(() => this.stopAndDestroy());
    }, this.graceMs);
  }

  private startPushLoop(): void {
    logVerbose(`[thread-status] push loop start: key=${this.key}`);
    // Immediate first push.
    void this.pushTick();
    this.pushTimer = setInterval(() => void this.pushTick(), this.pushIntervalMs);
  }

  private async pushTick(): Promise<void> {
    if (this.pushing) {
      return;
    }
    this.pushing = true;
    try {
      await this.pushFn(this.currentText);
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.pushing = false;
    }
  }

  private async pushOnce(text: string): Promise<void> {
    try {
      await this.pushFn(text);
    } catch (err) {
      this.onError?.(err);
    }
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private stopLoop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
  }

  private stopAndDestroy(): void {
    this.stopLoop();
    this.destroy();
  }

  private destroy(): void {
    logVerbose(`[thread-status] destroy: key=${this.key}`);
    this.cancelGrace();
    this.stopLoop();
    managers.delete(this.key);
  }
}
