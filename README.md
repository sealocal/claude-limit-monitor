# Claude Limit Monitor

A VS Code extension that monitors Anthropic API rate limit headers from Claude Code CLI traffic in real time.

## What it does

- Runs a local HTTP proxy that intercepts requests to `api.anthropic.com`
- Captures response headers: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`, and `retry-after`
- Displays current rate limit status in a sidebar panel
- Keeps a scrollable request history with color-coded status
- Shows a status bar indicator with remaining request percentage
- Warns you when you're close to hitting limits or get a 429

## Setup

### 1. Install the extension

```bash
cd claude-limit-monitor
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host, or package it:

```bash
npx @vscode/vsce package
code --install-extension claude-limit-monitor-0.1.0.vsix
```

### 2. Start the proxy

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
Claude Limit Monitor: Start Proxy
```

### 3. Configure Claude Code to use the proxy

Claude Code (and most Node.js tools) respect the `HTTP_PROXY` / `HTTPS_PROXY` environment variables. When `HTTPS_PROXY` is set, the client sends a `CONNECT` request to establish a tunnel. The proxy terminates TLS using a self-signed certificate, decrypts the traffic, captures rate-limit headers, then forwards requests to the real Anthropic API over HTTPS.

Because the proxy uses a self-signed certificate, you must disable TLS verification on the client side.

**macOS / Linux:**
```bash
export HTTP_PROXY=http://127.0.0.1:8919
export HTTPS_PROXY=http://127.0.0.1:8919
export NODE_TLS_REJECT_UNAUTHORIZED=0  # Required — proxy uses a self-signed cert
claude  # Start Claude Code as usual
```

**Windows (PowerShell):**
```powershell
$env:HTTP_PROXY = "http://127.0.0.1:8919"
$env:HTTPS_PROXY = "http://127.0.0.1:8919"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
claude
```

> **Tip:** The extension copies the env command to your clipboard when you start the proxy — just paste it into your terminal.

> **Security note:** `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS certificate verification for all outbound connections in that shell session. Only use this during local development/monitoring. Non-target hosts are tunneled through without interception.

### 4. Watch the dashboard

Open the **Claude Limit Monitor** panel in the Activity Bar (the pulse icon). You'll see:

- **Rate Limits** — live snapshot of remaining requests/tokens and reset times
- **Request History** — scrollable log of every intercepted API call

The status bar shows a percentage of remaining requests, turning yellow below 20%.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeLimitMonitor.proxyPort` | `8919` | Local proxy port |
| `claudeLimitMonitor.targetHosts` | `["api.anthropic.com"]` | Hostnames to intercept |
| `claudeLimitMonitor.autoStart` | `false` | Start proxy when VS Code opens |

## How it works

```
Claude Code CLI
    │
    │  HTTPS_PROXY=http://127.0.0.1:8919
    │  (sends CONNECT api.anthropic.com:443)
    ▼
┌──────────────────────────┐
│  Local HTTP Proxy         │
│  (127.0.0.1:8919)        │
│                           │
│  1. Accepts CONNECT       │
│  2. Terminates TLS        │  ◄── Self-signed cert
│     (MitM for target      │
│      hosts only)          │
│  3. Parses HTTP request   │
│  4. Forwards over HTTPS   │──► api.anthropic.com
│  5. Captures rate-limit   │
│     response headers      │
│  6. Relays response back  │
└──────────────────────────┘
```

When `HTTPS_PROXY` is set, the client sends a `CONNECT` request to tunnel through the proxy. For target hosts (`api.anthropic.com`), the proxy terminates TLS with a self-signed certificate, giving it access to the plaintext HTTP traffic. It forwards each request to the real API over HTTPS, captures the rate-limit response headers, and relays everything back to the client. Non-target hosts are tunneled through without interception.

## Rate Limit Headers Captured

| Header | Description |
|--------|-------------|
| `x-ratelimit-limit-requests` | Max requests per time window |
| `x-ratelimit-remaining-requests` | Requests remaining |
| `x-ratelimit-reset-requests` | Time until request limit resets |
| `x-ratelimit-limit-tokens` | Max tokens per time window |
| `x-ratelimit-remaining-tokens` | Tokens remaining |
| `x-ratelimit-reset-tokens` | Time until token limit resets |
| `retry-after` | Seconds to wait (on 429 responses) |

## Commands

- **Claude Limit Monitor: Start Proxy** — start the interception proxy
- **Claude Limit Monitor: Stop Proxy** — stop the proxy
- **Claude Limit Monitor: Show Dashboard** — toggle proxy from status bar
- **Claude Limit Monitor: Clear History** — clear the request log
