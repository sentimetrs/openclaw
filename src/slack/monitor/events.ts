import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";
import { registerSlackChannelEvents } from "./events/channels.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents } from "./events/messages.js";
import { registerSlackPinEvents } from "./events/pins.js";
import { registerSlackReactionEvents } from "./events/reactions.js";

export function registerSlackMonitorEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
  pushEarlyStatus: (message: SlackMessageEvent) => void;
}) {
  registerSlackMessageEvents({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
    pushEarlyStatus: params.pushEarlyStatus,
  });
  registerSlackReactionEvents({ ctx: params.ctx });
  registerSlackMemberEvents({ ctx: params.ctx });
  registerSlackChannelEvents({ ctx: params.ctx });
  registerSlackPinEvents({ ctx: params.ctx });
}
