import { logVerbose } from "../../globals.js";

export type StatusPhase = "reading" | "thinking" | "reasoning";

export type ThreadStatusHandle = {
  setStatus: (phase: StatusPhase) => void;
  /** Stop the counter timer so Slack can auto-clear status on bot reply. Next setStatus() restarts it. */
  pause: () => void;
  release: () => void;
};

type ThreadStatusManagerParams = {
  key: string;
  push: (status: string) => Promise<void>;
  graceMs: number;
  onError?: (err: unknown) => void;
};

// Module-level Map — one manager per channel+thread.
const managers = new Map<string, ThreadStatusManager>();

/**
 * For testing: clears all managers (stops timers, cancels grace).
 * @internal
 */
export function _resetAllManagers(): void {
  for (const mgr of managers.values()) {
    mgr.forceDestroy();
  }
  managers.clear();
}

/** Check if a thread has an active status manager with active handles. */
export function isThreadActive(key: string): boolean {
  const mgr = managers.get(key);
  return mgr ? mgr.isActive() : false;
}

/** Get the current formatted status text for a thread, or null. */
export function getCurrentStatus(key: string): string | null {
  const mgr = managers.get(key);
  return mgr ? mgr.getFormattedStatus() : null;
}

/** Re-push the current status text (instant restoration after Slack auto-clear). */
export function pushCurrentStatus(key: string): void {
  const mgr = managers.get(key);
  if (mgr) {
    mgr.rePush();
  }
}

/**
 * Acquire a shared status handle for a Slack thread.
 *
 * Multiple dispatches targeting the same thread share one manager,
 * preventing status blinks between sequential dispatches.
 */
export function acquireThreadStatus(params: {
  key: string;
  push: (status: string) => Promise<void>;
  graceMs?: number;
  shouldGrace?: () => boolean;
  onError?: (err: unknown) => void;
}): ThreadStatusHandle {
  const { key, push, graceMs = 5_000, shouldGrace, onError } = params;

  let mgr = managers.get(key);
  if (!mgr) {
    mgr = new ThreadStatusManager({
      key,
      push,
      graceMs,
      onError,
    });
    managers.set(key, mgr);
  }
  return mgr.acquire(shouldGrace);
}

const PHASE_LABELS: Record<StatusPhase, string> = {
  reading: "reading messages...",
  thinking: "thinking",
  reasoning: "reasoning",
};

function formatStatus(phase: StatusPhase, seconds: number): string {
  if (phase === "reading") {
    return PHASE_LABELS.reading;
  }
  return `${PHASE_LABELS[phase]} ${seconds}s`;
}

class ThreadStatusManager {
  private phase: StatusPhase | null = null;
  private seconds = 0;
  private activeHandles = 0;
  private counterTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;

  private readonly key: string;
  private readonly pushFn: (status: string) => Promise<void>;
  private readonly graceMs: number;
  private readonly onError?: (err: unknown) => void;

  constructor(params: ThreadStatusManagerParams) {
    this.key = params.key;
    this.pushFn = params.push;
    this.graceMs = params.graceMs;
    this.onError = params.onError;
  }

  isActive(): boolean {
    return this.activeHandles > 0;
  }

  getFormattedStatus(): string | null {
    if (!this.phase) {
      return null;
    }
    return formatStatus(this.phase, this.seconds);
  }

  /** Re-push current status (for instant restoration). */
  rePush(): void {
    const text = this.getFormattedStatus();
    if (text) {
      logVerbose(`[thread-status] rePush: key=${this.key} text="${text}"`);
      void this.pushOnce(text);
    }
  }

  acquire(shouldGrace?: () => boolean): ThreadStatusHandle {
    this.activeHandles++;
    this.cancelGrace();
    logVerbose(`[thread-status] acquire: key=${this.key} handles=${this.activeHandles}`);

    let released = false;
    return {
      setStatus: (phase: StatusPhase) => {
        if (released) {
          return;
        }
        this.setPhase(phase);
      },
      pause: () => {
        if (released) {
          return;
        }
        logVerbose(`[thread-status] pause: key=${this.key}`);
        this.stopCounter();
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
    this.stopCounter();
  }

  private setPhase(phase: StatusPhase): void {
    const changed = phase !== this.phase;
    this.phase = phase;
    this.seconds = 0;

    if (changed) {
      logVerbose(`[thread-status] setPhase: key=${this.key} phase="${phase}"`);
    }

    // Stop existing counter.
    this.stopCounter();

    // Push immediately.
    const text = formatStatus(phase, 0);
    void this.pushOnce(text);

    // Start 1s counter for thinking/reasoning.
    if (phase !== "reading") {
      this.counterTimer = setInterval(() => {
        this.seconds++;
        const tickText = formatStatus(this.phase!, this.seconds);
        void this.pushOnce(tickText);
      }, 1_000);
    }
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

    if (!this.phase) {
      // Never set status — just destroy.
      this.destroy();
      return;
    }

    // If the caller signals that no more dispatches are pending, stop immediately.
    if (graceResult === false) {
      logVerbose(`[thread-status] no pending — stop immediately: key=${this.key}`);
      this.stopAndDestroy();
      return;
    }

    // Grace period: keep current status visible between sequential dispatches.
    // Slack will auto-clear after bot posts or after 2min.
    // Stop counter so status text stays frozen during grace (no zombie ticks).
    this.stopCounter();
    logVerbose(`[thread-status] grace start: key=${this.key} graceMs=${this.graceMs}`);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      logVerbose(`[thread-status] grace end: key=${this.key}`);
      this.stopAndDestroy();
    }, this.graceMs);
  }

  private async pushOnce(text: string): Promise<void> {
    if (this.pushing) {
      return;
    }
    this.pushing = true;
    try {
      await this.pushFn(text);
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.pushing = false;
    }
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private stopCounter(): void {
    if (this.counterTimer) {
      clearInterval(this.counterTimer);
      this.counterTimer = null;
    }
  }

  private stopAndDestroy(): void {
    this.stopCounter();
    this.destroy();
  }

  private destroy(): void {
    logVerbose(`[thread-status] destroy: key=${this.key}`);
    this.cancelGrace();
    this.stopCounter();
    managers.delete(this.key);
  }
}
