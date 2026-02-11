import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const effectiveReplyToMode = params.context.ThreadLabel ? "all" : configuredReplyToMode;
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  const to = params.context.To;
  return {
    currentChannelId: to?.startsWith("channel:") ? to.slice("channel:".length) : undefined,
    currentDmUserId: to?.startsWith("user:") ? to.slice("user:".length) : undefined,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
