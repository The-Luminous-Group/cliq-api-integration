---
type: spec
status: draft
date: 2026-02-08
author: Guido (CTO)
relates-to:
  - LUM-53
  - task-22 (cross-machine agent messaging)
  - task-24 (inter-agent communication system)
---

# Spec: Bidirectional Cliq–Agent Messaging

## Problem

Agent-to-channel messaging is now working (bot incoming webhook). But agents cannot receive messages from Cliq. A human typing `@Guido check LUM-53` in #luminous has no way to reach a running Claude Code session.

## Goal

Messages sent to a Cliq bot (via @mention in a channel or direct message) should arrive in the agent's local inbox and be visible during an active Claude Code session.

## Architecture

### Current state (one-way)

```
Agent → bot webhook → Cliq channel
```

### Target state (bidirectional)

```
Agent → bot webhook → Cliq channel
Human on Cliq → @bot mention → poller → local inbox → Claude Code hook → Agent
```

### Components

#### 1. Local Cliq Poller (new)

A lightweight script that runs on each machine via launchd (macOS) or cron.

**Responsibilities:**
- Poll Cliq API for new messages to the bot every 30 seconds
- Use OAuth token (already working for reads) to call `GET /channels/{id}/messages` or bot message endpoint
- Filter for messages that @mention the bot or are direct messages to the bot
- Write new messages to the agent inbox as markdown files
- Track last-seen message ID to avoid duplicates

**Location:** `cliq-api-integration/scripts/cliq-poller.sh` (or `.ts`)

**Inbox path:** `~/Documents/dev/luminous/luminosity/src/agent-messages/{agent}/inbox/`

**File format:**
```markdown
---
from: barton
source: cliq
channel: luminous
timestamp: 2026-02-08T12:34:56Z
cliq_message_id: "msg_12345"
---

Check the Linear issue for LUM-53 — is it still blocked?
```

#### 2. Claude Code Hook (PreToolUse or SessionStart)

Checks the inbox for new Cliq messages and outputs them to the session context.

**Option A — PreToolUse (near real-time):**
- Fires before every tool call
- Checks a lightweight signal file (e.g., `~/.cliq-inbox/has-new`)
- Only reads full messages if the signal file exists
- Removes signal file after reading

**Option B — SessionStart (per-session):**
- Fires once at session start
- Reads all pending inbox messages
- Simpler but not real-time during a session

**Recommendation:** Start with SessionStart (option B). Add PreToolUse (option A) later if real-time matters.

#### 3. Bot Message Handler (Deluge — optional enhancement)

Currently the bot's incoming webhook handler routes our outbound messages to channels. The bot could also have a **message handler** that acknowledges receipt when someone @mentions it:

```deluge
response = Map();
response.put("text", "Got it — I'll pick this up in my next session.");
return response;
```

This gives humans immediate feedback that the bot received their message, even though the agent won't see it until the poller runs.

### Per-machine Setup

Each team member's machine needs:

| Component | What | Where |
|-----------|------|-------|
| Cliq MCP | Posts messages as bot | `cliq-api-integration/dist/index.js` (MCP server) |
| Poller | Reads messages from Cliq | `cliq-api-integration/scripts/cliq-poller.sh` (launchd) |
| Zapikey | Webhook token | 1Password: "Cliq luminous-agent-api" |
| OAuth creds | For reading API | 1Password: "cliq.zoho.com" |
| Bot | Per-agent identity | Created in Cliq admin (e.g., "Guido (barton)") |

### Bot Naming Convention

Each agent gets a bot per machine:

| Agent | Bot display name | Bot unique name | Machine |
|-------|-----------------|-----------------|---------|
| Guido | Guido (barton) | guidobarton | Barton's Mac |
| Guido | Guido (susan) | guidosusan | Susan's machine |
| Susan Opus | Susan (barton) | susanbarton | Barton's Mac |

The unique name encodes both the agent persona and the machine owner. This lets the same agent persona post from different machines with clear attribution.

## Implementation Order

1. **Poller script** — shell or TypeScript, reads recent channel messages, writes to inbox
2. **Launchd plist** — runs poller every 30 seconds
3. **SessionStart hook** — reads inbox at session start, outputs to context
4. **Bot message handler** — acknowledgement reply in Deluge
5. **PreToolUse hook** — real-time message checking (stretch goal)

## Open Questions

- Should the poller filter by @mention only, or capture all channel messages?
- How long should messages persist in the inbox before being archived?
- Should the poller also check direct messages to the bot (not just channel messages)?
- Rate limiting: Zoho API limits for polling frequency?

## Connects To

- **Agent messaging system** (`luminosity/src/agent-messages/`) — same inbox pattern
- **Logging protocol** — Cliq messages should appear in session logs
- **Invention log: Unified Agent Log Viewer** — Cliq messages as another event source
- **LUM-53** — inter-agent communication and logging system
