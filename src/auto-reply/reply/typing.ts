import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type TypingController = {
  onReplyStart: () => Promise<void>;
  startThinkingLoop: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  transitionToFollowup: () => void;
  resetForFollowup: () => void;
  cleanup: () => void;
};

export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  onCleanup?: () => void;
  onPhaseChange?: (phase: "thinking" | "typing") => void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
}): TypingController {
  const {
    onReplyStart,
    onCleanup,
    onPhaseChange,
    typingIntervalSeconds = 6,
    typingTtlMs = 2 * 60_000,
    silentToken = SILENT_REPLY_TOKEN,
    log,
  } = params;
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  let phase: "thinking" | "typing" | undefined;
  // Set by transitionToFollowup() so markDispatchIdle() can re-trigger typing
  // after all replies are delivered. External systems (e.g. Slack) may auto-clear
  // the status indicator when the bot sends a message; this flag ensures we
  // re-set it once the dispatch queue is fully drained.
  let transitioning = false;
  // Important: callbacks (tool/block streaming) can fire late (after the run completed),
  // especially when upstream event emitters don't await async listeners.
  // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
  let sealed = false;
  let typingTimer: NodeJS.Timeout | undefined;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = typingIntervalSeconds * 1000;

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
    transitioning = false;
    phase = undefined;
  };

  const cleanup = () => {
    if (sealed) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    // Notify the channel to stop its typing indicator (e.g., on NO_REPLY).
    // This fires only once (sealed prevents re-entry).
    if (active) {
      onCleanup?.();
    }
    resetCycle();
    sealed = true;
  };

  const refreshTypingTtl = () => {
    if (sealed) {
      return;
    }
    if (!typingIntervalMs || typingIntervalMs <= 0) {
      return;
    }
    if (typingTtlMs <= 0) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingTimer) {
        return;
      }
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup();
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed;

  const triggerTyping = async () => {
    if (sealed) {
      return;
    }
    await onReplyStart?.();
  };

  const ensureStart = async () => {
    if (sealed) {
      return;
    }
    // Late callbacks after a run completed should never restart typing.
    if (runComplete) {
      return;
    }
    if (!active) {
      active = true;
    }
    if (started) {
      return;
    }
    started = true;
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  };

  const startThinkingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      return;
    }
    if (!phase) {
      phase = "thinking";
      onPhaseChange?.("thinking");
    }
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingIntervalMs <= 0) {
      return;
    }
    if (typingTimer) {
      return;
    }
    await ensureStart();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };

  const startTypingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      return;
    }
    // Phase upgrade: thinking → typing
    const upgraded = phase === "thinking";
    if (!phase || phase === "thinking") {
      phase = "typing";
      onPhaseChange?.("typing");
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingIntervalMs <= 0) {
      return;
    }
    if (typingTimer) {
      // Timer already running from thinking phase — trigger immediate update
      if (upgraded) {
        await triggerTyping();
      }
      return;
    }
    await ensureStart();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      return;
    }
    const trimmed = text?.trim();
    if (!trimmed) {
      return;
    }
    if (silentToken && isSilentReplyText(trimmed, silentToken)) {
      return;
    }
    refreshTypingTtl();
    await startTypingLoop();
  };

  const markRunComplete = () => {
    runComplete = true;
    maybeStopOnIdle();
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    maybeStopOnIdle();
    // Re-trigger status after all replies are delivered. External systems
    // (e.g. Slack assistant.threads.setStatus) auto-clear the indicator
    // when the bot posts a message. If we're transitioning to a followup
    // run, immediately re-set the status so the user sees continuity.
    if (transitioning && active && !sealed) {
      transitioning = false;
      void triggerTyping();
    }
  };

  const transitionToFollowup = () => {
    if (sealed) {
      return;
    }
    // Keep controller alive: don't set runComplete, don't cleanup.
    // Reset started so ensureStart can fire again for the next run.
    started = false;
    runComplete = false;
    // Signal that we expect markDispatchIdle to re-trigger typing after
    // the final reply is delivered (external systems may clear the status).
    transitioning = true;
    // Switch phase to thinking (waiting for followup LLM).
    if (phase !== "thinking") {
      phase = "thinking";
      onPhaseChange?.("thinking");
      // Immediate status update.
      void triggerTyping();
    }
    // Restart the typing indicator timer with a short interval.
    // External systems (e.g. Slack) may clear the status with a delay
    // (1-3s) after the bot posts a message. A short interval ensures
    // rapid re-set so the user sees continuity between main run and followup.
    // resetForFollowup() clears this timer before the followup starts.
    if (onReplyStart && typingIntervalMs > 0) {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      const transitionIntervalMs = Math.min(typingIntervalMs, 2000);
      typingTimer = setInterval(() => {
        void triggerTyping();
      }, transitionIntervalMs);
    }
  };

  const resetForFollowup = () => {
    // Clear timers.
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    // Full reset — controller is reusable.
    sealed = false;
    started = false;
    active = false;
    runComplete = false;
    transitioning = false;
    // Set dispatchIdle=true: followup runs have no dispatcher, so "dispatch" is always idle.
    dispatchIdle = true;
    phase = undefined;
  };

  return {
    onReplyStart: ensureStart,
    startThinkingLoop,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    transitionToFollowup,
    resetForFollowup,
    cleanup,
  };
}
