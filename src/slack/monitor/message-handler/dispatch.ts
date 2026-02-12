import type { PreparedSlackMessage } from "./types.js";
import { resolveHumanDelayConfig } from "../../../agents/identity.js";
import { dispatchInboundMessage } from "../../../auto-reply/dispatch.js";
import { clearHistoryEntriesIfEnabled } from "../../../auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply } from "../../../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../channels/logging.js";
import { createReplyPrefixOptions } from "../../../channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../channels/typing.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { removeSlackReaction } from "../../actions.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { createSlackReplyDeliveryPlan, deliverReplies } from "../replies.js";

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "slack",
        to: `user:${message.user}`,
        accountId: route.accountId,
      },
      ctx: prepared.ctxPayload,
    });
  }

  const { statusThreadTs } = resolveSlackThreadTargets({
    message,
    replyToMode: ctx.replyToMode,
  });

  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;

  // Explicit phase-based Slack assistant status:
  // 1. "thinking..."      – set immediately at dispatch
  // 2. "working..." / text / "working: toolName…" – LLM output (onPartialReply / onToolUse)
  // 3. "typing..."        – before deliverReplies
  // 4. ""                 – cleanup on idle
  //
  // No periodic typing loop — Slack assistant.threads.setStatus is persistent.
  let lastWorkingStatusAt = 0;
  const WORKING_STATUS_DEBOUNCE_MS = 3000;
  const STATUS_PREVIEW_MAX_LEN = 80;

  if (statusThreadTs) {
    didSetStatus = true;
    ctx
      .setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "thinking...",
      })
      .catch(() => {});
  }

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: ctx.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // No-op: Slack status is managed via explicit phase callbacks.
      // Periodic typing loop refresh is unnecessary — assistant.threads.setStatus is persistent.
      didSetStatus = true;
    },
    stop: async () => {
      if (!didSetStatus) {
        return;
      }
      didSetStatus = false;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "",
      });
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => runtime.error?.(danger(message)),
        channel: "slack",
        action: "start",
        target: typingTarget,
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => runtime.error?.(danger(message)),
        channel: "slack",
        action: "stop",
        target: typingTarget,
        error: err,
      });
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      if (statusThreadTs) {
        didSetStatus = true;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "typing...",
        });
      }
      const replyThreadTs = replyPlan.nextThreadTs();
      await deliverReplies({
        replies: [payload],
        target: prepared.replyTarget,
        token: ctx.botToken,
        accountId: account.accountId,
        runtime,
        textLimit: ctx.textLimit,
        replyThreadTs,
      });
      replyPlan.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: typingCallbacks.onIdle,
  });

  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: prepared.ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: prepared.channelConfig?.skills,
      hasRepliedRef,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected,
      onReasoningStream: undefined,
      onPartialReply: statusThreadTs
        ? async (payload) => {
            const now = Date.now();
            if (now - lastWorkingStatusAt < WORKING_STATUS_DEBOUNCE_MS) {
              return;
            }
            lastWorkingStatusAt = now;
            didSetStatus = true;
            const text = payload.text?.replace(/\n/g, " ").trim();
            const status =
              text && text.length > 0
                ? text.length <= STATUS_PREVIEW_MAX_LEN
                  ? text
                  : text.slice(0, STATUS_PREVIEW_MAX_LEN) + "…"
                : "working…";
            ctx
              .setSlackThreadStatus({
                channelId: message.channel,
                threadTs: statusThreadTs,
                status,
              })
              .catch(() => {});
          }
        : undefined,
      onToolUse: statusThreadTs
        ? (toolName) => {
            didSetStatus = true;
            const status = toolName ? `working: ${toolName}…` : "working…";
            ctx
              .setSlackThreadStatus({
                channelId: message.channel,
                threadTs: statusThreadTs,
                status,
              })
              .catch(() => {});
          }
        : undefined,
      onDrainPhaseChange: statusThreadTs
        ? (phase) => {
            const status = phase === "debounce-start" ? "read messages..." : "thinking...";
            didSetStatus = true;
            ctx
              .setSlackThreadStatus({
                channelId: message.channel,
                threadTs: statusThreadTs,
                status,
              })
              .catch(() => {});
          }
        : undefined,
    },
  });
  markDispatchIdle();

  const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

  if (!anyReplyDelivered) {
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  removeAckReactionAfterReply({
    removeAfterReply: ctx.removeAckAfterReply,
    ackReactionPromise: prepared.ackReactionPromise,
    ackReactionValue: prepared.ackReactionValue,
    remove: () =>
      removeSlackReaction(
        message.channel,
        prepared.ackReactionMessageTs ?? "",
        prepared.ackReactionValue,
        {
          token: ctx.botToken,
          client: ctx.app.client,
        },
      ),
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
