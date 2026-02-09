#!/usr/bin/env node

/**
 * MCP server for Zoho Cliq.
 *
 * Sends messages as a bot via incoming webhook (zapikey from 1Password).
 * Lists channels via OAuth access token.
 *
 * Auth:
 * - Webhook token: 1Password item "Cliq luminous-agent-api" (field: credential)
 * - OAuth: 1Password item "cliq.zoho.com" (fields: refresh_token, client_id, client_secret)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listChannels, sendMessage } from "./lib/cliq-api.js";
import { ListChannelsSchema, SendMessageSchema } from "./lib/schemas.js";

const CLIQ_TOOLS = [
  {
    name: "cliq_list_channels",
    description: "List all channels in your Zoho Cliq workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "cliq_send_message",
    description:
      "Send a message to a Zoho Cliq channel. Specify one of: channelId, channelName (unique name), chatId, or userId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Message text to send (required).",
        },
        channelName: {
          type: "string",
          description: "Channel unique name (e.g., 'engineering-team'). Defaults to 'luminous'.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "cliq_reply_to_message",
    description:
      "Reply to a specific message in Zoho Cliq (creates a threaded reply).",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "The ID of the message to reply to.",
        },
        text: {
          type: "string",
          description: "Reply text.",
        },
      },
      required: ["messageId", "text"],
    },
  },
];

// ---------- server setup ----------

const server = new Server(
  { name: "cliq-api-integration", version: "0.2.0" },
  { capabilities: { resources: {}, tools: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CLIQ_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "cliq_list_channels": {
        ListChannelsSchema.parse(args);
        const result = await listChannels();
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result.channels, null, 2),
            },
          ],
        };
      }

      case "cliq_send_message": {
        const validated = SendMessageSchema.parse(args);
        const result = await sendMessage(validated);
        if (result.error) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text: `Message sent to #${validated.channelName || "luminous"} as bot.`,
            },
          ],
        };
      }

      case "cliq_reply_to_message": {
        return {
          content: [{ type: "text", text: "Reply-to-message is not yet supported via bot webhook." }],
          isError: true,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// ---------- start server ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
