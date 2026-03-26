# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A VS Code extension that monitors Anthropic API rate limit headers from Claude Code CLI traffic in real time. It runs a local HTTP proxy with TLS MitM that intercepts HTTPS requests to `api.anthropic.com`, captures rate-limit response headers, and displays them in a VS Code sidebar panel.

## Build Commands

- `npm run compile` — TypeScript compilation to `out/`
- `npm run watch` — Watch mode (default VS Code build task)
- Press F5 in VS Code to launch Extension Development Host for testing

There are no tests or linting configured.

## Architecture

Three source files in `src/`, compiled to `out/` as CommonJS (ES2022 target):

- **extension.ts** — Extension entry point. Registers 4 commands (start/stop proxy, show dashboard, clear history), creates two tree view providers, manages status bar item, and fires warning notifications when rate limits are close to exhaustion.

- **proxy.ts** — `AnthropicProxy` class (extends EventEmitter). Generates self-signed TLS certs via `selfsigned` on startup. Handles both regular HTTP forwarding and HTTPS CONNECT tunneling with MitM for target hosts (plain TCP passthrough for non-targets). Captures 7 rate-limit headers from responses and emits `rateLimit` events.

- **views.ts** — Two VS Code TreeDataProviders: `RateLimitStatusProvider` (current rate limit snapshot with percentages and reset times) and `RequestHistoryProvider` (scrollable log of last 100 requests with color-coded status icons and hover tooltips).

## Key Technical Details

- The proxy requires `NODE_TLS_REJECT_UNAUTHORIZED=0` on the client side due to self-signed certificates.
- Default proxy port is 8919, configurable via `claudeRateMonitor.proxyPort` setting.
- Target hosts for interception default to `["api.anthropic.com"]`, configurable via `claudeRateMonitor.targetHosts`.
- Only production dependency is `selfsigned` (^5.5.0).
