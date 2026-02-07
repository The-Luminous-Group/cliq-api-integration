/**
 * Zoho Cliq API client.
 *
 * Uses OAuth 2.0 for authentication with access tokens stored in config file or 1Password.
 *
 * References:
 * - https://www.zoho.com/cliq/help/restapi/v2/
 * - https://www.zoho.com/cliq/help/platform/post-to-channel.html
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

// ---------- types ----------

export interface CliqChannel {
  id: string;
  name: string;
  unique_name: string;
}

export interface CliqMessage {
  text: string;
  channelId?: string;
  chatId?: string;
  userId?: string;
}

export interface SendMessageInput {
  text: string;
  channelId?: string;
  channelName?: string;
  chatId?: string;
  userId?: string;
}

interface ApiResponse {
  data: unknown;
  error: string | null;
}

// ---------- auth ----------

const CONFIG_PATH = join(homedir(), ".cliq-api-config.json");
const OP_ITEM_ID = process.env.CLIQ_OP_ITEM || "cliq.zoho.com";
const BASE_URL = process.env.CLIQ_BASE_URL || "https://cliq.zoho.com/api/v2";

// In-memory token cache
let cachedToken: string | null = null;

function loadToken(): string | null {
  if (cachedToken) return cachedToken;

  // 1. Environment variable
  const envToken = process.env.CLIQ_ACCESS_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  // 2. Config file
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (config.access_token && config.expires_at && Date.now() < config.expires_at) {
        cachedToken = config.access_token;
        return cachedToken;
      }
    } catch {
      // Fall through to 1Password
    }
  }

  // 3. 1Password (refresh token stored there)
  try {
    const result = execSync(
      `op item get "${OP_ITEM_ID}" --fields label=refresh_token --format json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(result);
    const refreshToken = parsed.find((f: { label: string }) => f.label === "refresh_token")?.value;

    if (refreshToken) {
      return refreshAccessToken(refreshToken);
    }
  } catch {
    // Fall through
  }

  return null;
}

function refreshAccessToken(refreshToken: string): string | null {
  try {
    // Get client credentials from 1Password
    const clientIdResult = execSync(
      `op item get "${OP_ITEM_ID}" --fields label=client_id --format json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const clientSecretResult = execSync(
      `op item get "${OP_ITEM_ID}" --fields label=client_secret --format json`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const clientId = JSON.parse(clientIdResult).find((f: { label: string }) => f.label === "client_id")?.value;
    const clientSecret = JSON.parse(clientSecretResult).find((f: { label: string }) => f.label === "client_secret")?.value;

    if (!clientId || !clientSecret) return null;

    // Refresh the token
    const result = execSync(
      `curl -s -X POST 'https://accounts.zoho.com/oauth/v2/token' ` +
      `-d 'refresh_token=${refreshToken}' ` +
      `-d 'client_id=${clientId}' ` +
      `-d 'client_secret=${clientSecret}' ` +
      `-d 'grant_type=refresh_token'`,
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    );

    const response = JSON.parse(result);
    if (response.access_token) {
      const token = response.access_token;
      const expiresIn = response.expires_in || 3600; // Default 1 hour

      // Cache to file
      try {
        writeFileSync(
          CONFIG_PATH,
          JSON.stringify({
            access_token: token,
            expires_at: Date.now() + expiresIn * 1000,
            created: new Date().toISOString(),
            source: "1password-refresh",
          }),
          { mode: 0o600 }
        );
      } catch {
        // Non-fatal
      }

      cachedToken = token;
      return token;
    }
  } catch {
    return null;
  }

  return null;
}

function clearTokenCache(): void {
  cachedToken = null;
  try {
    if (existsSync(CONFIG_PATH)) {
      writeFileSync(CONFIG_PATH, "{}", { mode: 0o600 });
    }
  } catch {
    // ignore
  }
}

// ---------- HTTP helpers ----------

async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<ApiResponse> {
  const token = loadToken();
  if (!token) {
    return { data: null, error: "No access token available. Check CLIQ_ACCESS_TOKEN env var or 1Password item." };
  }

  const url = endpoint.startsWith("http") ? endpoint : `${BASE_URL}${endpoint}`;

  try {
    const bodyStr = body ? JSON.stringify(body) : "";
    const curlCmd =
      `curl -s -X ${method} '${url}' ` +
      `-H 'Authorization: Zoho-oauthtoken ${token}' ` +
      `-H 'Content-Type: application/json' ` +
      (body ? `-d '${bodyStr.replace(/'/g, "'\\''")}'` : "");

    const result = execSync(curlCmd, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const data = JSON.parse(result);

    // Check for 401 and retry with fresh token
    if (data.code === "INVALID_OAUTH" || data.code === "OAUTH_EXPIRED") {
      clearTokenCache();
      const newToken = loadToken();
      if (!newToken) {
        return { data: null, error: "Failed to refresh access token" };
      }

      // Retry with new token
      const retryCmd = curlCmd.replace(`Zoho-oauthtoken ${token}`, `Zoho-oauthtoken ${newToken}`);
      const retryResult = execSync(retryCmd, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      return { data: JSON.parse(retryResult), error: null };
    }

    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- API functions ----------

export async function listChannels(): Promise<{
  channels: CliqChannel[];
  error: string | null;
}> {
  const { data, error } = await apiRequest("/channels");
  if (error || !data) return { channels: [], error };

  const response = data as { channels?: Array<{ id: string; name: string; unique_name: string }> };
  if (!response.channels) return { channels: [], error: "Unexpected response format" };

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
  message: unknown;
  error: string | null;
}> {
  if (!input.text) {
    return { message: null, error: "Message text is required" };
  }

  let endpoint: string;

  if (input.channelId) {
    endpoint = `/channels/${input.channelId}/messages`;
  } else if (input.channelName) {
    endpoint = `/channelsbyname/${input.channelName}/message`;
  } else if (input.chatId) {
    endpoint = `/chats/${input.chatId}/messages`;
  } else if (input.userId) {
    endpoint = `/users/${input.userId}/messages`;
  } else {
    return { message: null, error: "Must specify channelId, channelName, chatId, or userId" };
  }

  const payload = {
    text: input.text,
    sync_message: true,
  };

  const { data, error } = await apiRequest(endpoint, "POST", payload);
  if (error || !data) return { message: null, error };

  return { message: data, error: null };
}

export async function replyToMessage(input: {
  messageId: string;
  text: string;
}): Promise<{
  reply: unknown;
  error: string | null;
}> {
  if (!input.text || !input.messageId) {
    return { reply: null, error: "Message ID and text are required" };
  }

  const payload = {
    text: input.text,
    parent_message_id: input.messageId,
  };

  const { data, error } = await apiRequest("/messages", "POST", payload);
  if (error || !data) return { reply: null, error };

  return { reply: data, error: null };
}
