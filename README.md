# Claude Rate Limit Monitor

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
cd claude-rate-monitor
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host, or package it:

```bash
npx @vscode/vsce package
code --install-extension claude-rate-monitor-0.1.0.vsix
```

### 2. Start the proxy

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
Claude Rate Monitor: Start Proxy
```

### 3. Configure Claude Code to use the proxy

Claude Code (and most Node.js tools) respect the `HTTP_PROXY` / `HTTPS_PROXY` environment variables. Before launching Claude Code, set them in your terminal:

**macOS / Linux:**
```bash
export HTTP_PROXY=http://127.0.0.1:8919
export HTTPS_PROXY=http://127.0.0.1:8919
export NODE_TLS_REJECT_UNAUTHORIZED=0  # Required for HTTPS interception
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

> **Note:** `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS certificate verification so the proxy can inspect HTTPS traffic. Only use this during local development/monitoring.

### 4. Watch the dashboard

Open the **Claude Rate Monitor** panel in the Activity Bar (the pulse icon). You'll see:

- **Rate Limits** — live snapshot of remaining requests/tokens and reset times
- **Request History** — scrollable log of every intercepted API call

The status bar shows a percentage of remaining requests, turning yellow below 20%.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeRateMonitor.proxyPort` | `8919` | Local proxy port |
| `claudeRateMonitor.targetHosts` | `["api.anthropic.com"]` | Hostnames to intercept |
| `claudeRateMonitor.autoStart` | `false` | Start proxy when VS Code opens |

## How it works

```
Claude Code CLI
    │
    │  HTTP_PROXY=http://127.0.0.1:8919
    ▼
┌─────────────────────┐
│  Local HTTP Proxy    │  ◄── Captures response headers
│  (127.0.0.1:8919)   │
└─────────┬───────────┘
          │
          ▼
   api.anthropic.com
```

When `HTTP_PROXY` is set, Node.js sends requests as plain HTTP to the proxy (even for HTTPS URLs). The proxy forwards them to the real Anthropic API over HTTPS, reads the response headers, and relays everything back. This avoids the complexity of TLS MitM certificates.

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

- **Claude Rate Monitor: Start Proxy** — start the interception proxy
- **Claude Rate Monitor: Stop Proxy** — stop the proxy
- **Claude Rate Monitor: Show Dashboard** — toggle proxy from status bar
- **Claude Rate Monitor: Clear History** — clear the request log
