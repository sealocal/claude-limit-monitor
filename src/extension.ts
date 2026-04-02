import * as vscode from "vscode";
import { AnthropicProxy, RateLimitInfo } from "./proxy";
import { RateLimitStatusProvider, RequestHistoryProvider } from "./views";

let proxy: AnthropicProxy | null = null;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeLimitMonitor");
  const port = config.get<number>("proxyPort", 8919);
  const targetHosts = config.get<string[]>("targetHosts", [
    "api.anthropic.com",
  ]);

  // Create tree view providers
  const statusProvider = new RateLimitStatusProvider();
  const historyProvider = new RequestHistoryProvider();

  vscode.window.registerTreeDataProvider(
    "claudeLimitMonitor.statusView",
    statusProvider
  );
  vscode.window.registerTreeDataProvider(
    "claudeLimitMonitor.historyView",
    historyProvider
  );

  // Status bar item
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "claudeLimitMonitor.showDashboard";
  statusBar.text = "$(pulse) Claude Limit: Off";
  statusBar.tooltip = "Claude Limit Monitor — click to toggle";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeLimitMonitor.start", async () => {
      if (proxy?.isRunning) {
        vscode.window.showInformationMessage(
          `Proxy already running on port ${port}`
        );
        return;
      }

      proxy = new AnthropicProxy(port, targetHosts);

      proxy.on("rateLimit", (info: RateLimitInfo) => {
        if (!info.path.startsWith("/api/event_logging/")) {
          statusProvider.update(info);
          historyProvider.add(info);
        }
        updateStatusBar(info);

        // Warn if close to limits
        const util5h = parseFloat(info.headers["anthropic-ratelimit-unified-5h-utilization"] || "0");
        if (info.statusCode === 429) {
          vscode.window.showWarningMessage(
            `Rate limited! Retry after ${info.headers["retry-after"] || "?"}s`
          );
        } else if (util5h >= 0.9) {
          vscode.window.showWarningMessage(
            `5h rate limit at ${Math.round(util5h * 100)}% usage`
          );
        }
      });

      proxy.on("error", (err: Error) => {
        vscode.window.showErrorMessage(`Proxy error: ${err.message}`);
      });

      proxy.on("stopped", () => {
        statusProvider.setProxyStatus(false);
        statusBar.text = "$(pulse) Claude Limit: Off";
      });

      proxy.on("tunnel", (info: { hostname: string }) => {
        // CONNECT-based tunnel (metadata only)
        vscode.window.showInformationMessage(
          `Tunnel to ${info.hostname} (use HTTP_PROXY for full header capture)`
        );
      });

      try {
        await proxy.start();
        statusProvider.setProxyStatus(true);
        statusBar.text = "$(pulse) Claude Limit: On";
        statusBar.backgroundColor = undefined;

        const msg = await vscode.window.showInformationMessage(
          `Proxy running on 127.0.0.1:${port}. Set HTTP_PROXY to use it.`,
          "Copy env command"
        );
        if (msg) {
          const cmd =
            process.platform === "win32"
              ? `set HTTP_PROXY=http://127.0.0.1:${port} && set HTTPS_PROXY=http://127.0.0.1:${port}`
              : `export HTTP_PROXY=http://127.0.0.1:${port} HTTPS_PROXY=http://127.0.0.1:${port}`;
          await vscode.env.clipboard.writeText(cmd);
          vscode.window.showInformationMessage("Copied to clipboard!");
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to start proxy: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeLimitMonitor.stop", async () => {
      if (!proxy?.isRunning) {
        // Heal any UI desync (e.g. server closed unexpectedly before 'stopped' fired)
        statusProvider.setProxyStatus(false);
        statusBar.text = "$(pulse) Claude Limit: Off";
        return;
      }
      await proxy.stop();
      // UI is updated by the 'stopped' event listener, but set here too for safety
      statusProvider.setProxyStatus(false);
      statusBar.text = "$(pulse) Claude Limit: Off";
      vscode.window.showInformationMessage("Proxy stopped");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeLimitMonitor.showDashboard", () => {
      // Toggle proxy on/off from status bar
      if (proxy?.isRunning) {
        vscode.commands.executeCommand("claudeLimitMonitor.stop");
      } else {
        vscode.commands.executeCommand("claudeLimitMonitor.start");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeLimitMonitor.clear", () => {
      historyProvider.clear();
      vscode.window.showInformationMessage("Request history cleared");
    })
  );

  // Auto-start if configured
  if (config.get<boolean>("autoStart", false)) {
    vscode.commands.executeCommand("claudeLimitMonitor.start");
  }
}

function updateStatusBar(info: RateLimitInfo) {
  if (info.statusCode === 429) {
    statusBar.text = "$(error) Claude Limit: 429!";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    return;
  }
  const util5h = info.headers["anthropic-ratelimit-unified-5h-utilization"];
  if (util5h !== undefined) {
    const pct = Math.round(parseFloat(util5h) * 100);
    statusBar.text = `$(pulse) Claude Limit: ${pct}% used`;
    statusBar.backgroundColor = pct >= 80
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    return;
  }
  // Fallback: traditional requests-based header
  const rem = info.rateLimits.requestsRemaining;
  const lim = info.rateLimits.requestsLimit;
  if (rem !== null && lim !== null) {
    const pct = Math.round((parseInt(rem) / parseInt(lim)) * 100);
    statusBar.text = `$(pulse) Claude Limit: ${pct}%`;
    statusBar.backgroundColor = pct < 20
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  }
}

export function deactivate() {
  if (proxy?.isRunning) {
    proxy.stop();
  }
}
