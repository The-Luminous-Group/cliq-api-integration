/**
 * Zod validation schemas for Cliq MCP tools
 */

import { z } from "zod";

export const ListChannelsSchema = z.object({});

export const SendMessageSchema = z.object({
  text: z.string().min(1, "Message text is required"),
  channelId: z.string().optional(),
  channelName: z.string().optional(),
  chatId: z.string().optional(),
  userId: z.string().optional(),
}).refine(
  (data) => data.channelId || data.channelName || data.chatId || data.userId,
  { message: "Must specify at least one of: channelId, channelName, chatId, or userId" }
);

export const ReplyToMessageSchema = z.object({
  messageId: z.string().min(1, "Message ID is required"),
  text: z.string().min(1, "Reply text is required"),
});
