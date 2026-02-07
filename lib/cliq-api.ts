/**
 * Zoho Cliq API client.
 *
 * Sends messages via bot incoming webhook (zapikey from 1Password).
 * Lists channels via OAuth access token (refresh token from 1Password).
 *
 * References:
 * - https://www.zoho.com/cliq/help/platform/webhook-tokens.html
 * - https://www.zoho.com/cliq/help/platform/bot-incomingwebhookhandler.html
 * - https://www.zoho.com/cliq/help/restapi/v2/
 */

import { execSync } from "child_process";

// ---------- types ----------

export interface CliqChannel {
  id: string;
  name: string;
  unique_name: string;
}

export interface SendMessageInput {
  text: string;
  channelName?: string;
  chatId?: string;
  userId?: string;
}

// ---------- config ----------

const BASE_URL = "https://cliq.zoho.com/api/v2";
const BOT_NAME = process.env.CLIQ_BOT_NAME || "guidobarton";
const DEFAULT_CHANNEL = process.env.CLIQ_DEFAULT_CHANNEL || "luminous";
const WEBHOOK_OP_ITEM = process.env.CLIQ_WEBHOOK_OP_ITEM || "Cliq luminous-agent-api";
const OAUTH_OP_ITEM = process.env.CLIQ_OAUTH_OP_ITEM || "cliq.zoho.com";

// ---------- auth ----------

let cachedZapikey: string | null = null;
let cachedOAuthToken: string | null = null;
let oauthExpiresAt = 0;

function opGet(item: string, field: string): string | null {
  try {
    const result = execSync(
      `op item get "${item}" --fields label=${field} --format json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(result);
    return Array.isArray(parsed)
      ? parsed.find((f: { label: string }) => f.label === field)?.value ?? null
      : parsed.value ?? null;
  } catch {
    return null;
  }
}

function getZapikey(): string | null {
  if (cachedZapikey) return cachedZapikey;

  const envKey = process.env.CLIQ_ZAPIKEY;
  if (envKey) {
    cachedZapikey = envKey;
    return cachedZapikey;
  }

  cachedZapikey = opGet(WEBHOOK_OP_ITEM, "credential");
  return cachedZapikey;
}

function getOAuthToken(): string | null {
  if (cachedOAuthToken && Date.now() < oauthExpiresAt) return cachedOAuthToken;

  const refreshToken = opGet(OAUTH_OP_ITEM, "refresh_token");
  if (!refreshToken) return null;

  const clientId = opGet(OAUTH_OP_ITEM, "client_id");
  const clientSecret = opGet(OAUTH_OP_ITEM, "client_secret");
  if (!clientId || !clientSecret) return null;

  try {
    const result = execSync(
      `curl -s -X POST 'https://accounts.zoho.com/oauth/v2/token' ` +
        `-d 'refresh_token=${refreshToken}' ` +
        `-d 'client_id=${clientId}' ` +
        `-d 'client_secret=${clientSecret}' ` +
        `-d 'grant_type=refresh_token'`,
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const response = JSON.parse(result);
    if (response.access_token) {
      cachedOAuthToken = response.access_token;
      oauthExpiresAt = Date.now() + (response.expires_in || 3600) * 1000;
      return cachedOAuthToken;
    }
  } catch {
    // Fall through
  }

  return null;
}

// ---------- HTTP helpers ----------

function curlJson(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: unknown,
): { data: unknown; status: number } {
  const headerFlags = Object.entries(headers)
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(" ");

  const bodyStr = body ? JSON.stringify(body) : "";
  const bodyFlag = body ? `-d '${bodyStr.replace(/'/g, "'\\''")}'` : "";

  const cmd =
    `curl -s -o /tmp/cliq-mcp-response.txt -w "%{http_code}" ` +
    `-X ${method} '${url}' ${headerFlags} ${bodyFlag}`;

  const statusStr = execSync(cmd, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const status = parseInt(statusStr, 10);
  let data: unknown = null;
  try {
    const { readFileSync } = require("fs");
    const raw = readFileSync("/tmp/cliq-mcp-response.txt", "utf8");
    if (raw) data = JSON.parse(raw);
  } catch {
    // Empty body (204) or non-JSON response
  }

  return { data, status };
}

// ---------- API functions ----------

export async function listChannels(): Promise<{
  channels: CliqChannel[];
  error: string | null;
}> {
  const token = getOAuthToken();
  if (!token) {
    return { channels: [], error: "No OAuth token available. Check 1Password item 'cliq.zoho.com'." };
  }

  const { data, status } = curlJson(
    `${BASE_URL}/channels`,
    "GET",
    { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
  );

  if (status < 200 || status >= 300) {
    return { channels: [], error: `HTTP ${status}: ${JSON.stringify(data)}` };
  }

  const response = data as { channels?: Array<{ id: string; name: string; unique_name: string }> };
  if (!response?.channels) return { channels: [], error: "Unexpected response format" };

  return {
    channels: response.channels.map((c) => ({
      id: c.id,
      name: c.name,
      unique_name: c.unique_name,
    })),
    error: null,
  };
}

export async function sendMessage(input: SendMessageInput): Promise<{
  success: boolean;
  error: string | null;
}> {
  if (!input.text) {
    return { success: false, error: "Message text is required" };
  }

  const zapikey = getZapikey();
  if (!zapikey) {
    return { success: false, error: "No webhook token available. Check 1Password item 'Cliq luminous-agent-api'." };
  }

  const channel = input.channelName || DEFAULT_CHANNEL;
  const url = `${BASE_URL}/bots/${BOT_NAME}/incoming?zapikey=${zapikey}`;

  const payload: Record<string, string> = { text: input.text, channel };

  const { status, data } = curlJson(url, "POST", { "Content-Type": "application/json" }, payload);

  if (status >= 200 && status < 300) {
    return { success: true, error: null };
  }

  return { success: false, error: `HTTP ${status}: ${JSON.stringify(data)}` };
}
