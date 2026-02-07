/**
 * Zod validation schemas for Cliq MCP tools
 */

import { z } from "zod";

export const ListChannelsSchema = z.object({});

export const SendMessageSchema = z.object({
  text: z.string().min(1, "Message text is required"),
  channelName: z.string().optional(),
});
