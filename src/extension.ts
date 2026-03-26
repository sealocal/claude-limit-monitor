import * as vscode from "vscode";
import { AnthropicProxy, RateLimitInfo } from "./proxy";
import { RateLimitStatusProvider, RequestHistoryProvider } from "./views";

let proxy: AnthropicProxy | null = null;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeRateMonitor");
  const port = config.get<number>("proxyPort", 8919);
  const targetHosts = config.get<string[]>("targetHosts", [
    "api.anthropic.com",
  ]);

  // Create tree view providers
  const statusProvider = new RateLimitStatusProvider();
  const historyProvider = new RequestHistoryProvider();

  vscode.window.registerTreeDataProvider(
    "claudeRateMonitor.statusView",
    statusProvider
  );
  vscode.window.registerTreeDataProvider(
    "claudeRateMonitor.historyView",
    historyProvider
  );

  // Status bar item
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "claudeRateMonitor.showDashboard";
  statusBar.text = "$(pulse) Claude RL: Off";
  statusBar.tooltip = "Claude Rate Limit Monitor — click to toggle";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRateMonitor.start", async () => {
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

      proxy.on("tunnel", (info: { hostname: string }) => {
        // CONNECT-based tunnel (metadata only)
        vscode.window.showInformationMessage(
          `Tunnel to ${info.hostname} (use HTTP_PROXY for full header capture)`
        );
      });

      try {
        await proxy.start();
        statusProvider.setProxyStatus(true);
        statusBar.text = "$(pulse) Claude RL: On";
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
    vscode.commands.registerCommand("claudeRateMonitor.stop", async () => {
      if (!proxy?.isRunning) {
        vscode.window.showInformationMessage("Proxy is not running");
        return;
      }
      await proxy.stop();
      statusProvider.setProxyStatus(false);
      statusBar.text = "$(pulse) Claude RL: Off";
      vscode.window.showInformationMessage("Proxy stopped");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRateMonitor.showDashboard", () => {
      // Toggle proxy on/off from status bar
      if (proxy?.isRunning) {
        vscode.commands.executeCommand("claudeRateMonitor.stop");
      } else {
        vscode.commands.executeCommand("claudeRateMonitor.start");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRateMonitor.clear", () => {
      historyProvider.clear();
      vscode.window.showInformationMessage("Request history cleared");
    })
  );

  // Auto-start if configured
  if (config.get<boolean>("autoStart", false)) {
    vscode.commands.executeCommand("claudeRateMonitor.start");
  }
}

function updateStatusBar(info: RateLimitInfo) {
  if (info.statusCode === 429) {
    statusBar.text = "$(error) Claude RL: 429!";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    return;
  }
  const util5h = info.headers["anthropic-ratelimit-unified-5h-utilization"];
  if (util5h !== undefined) {
    const pct = Math.round(parseFloat(util5h) * 100);
    statusBar.text = `$(pulse) Claude RL: ${pct}% used`;
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
    statusBar.text = `$(pulse) Claude RL: ${pct}%`;
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
