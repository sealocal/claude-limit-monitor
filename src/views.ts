import * as vscode from "vscode";
import { RateLimitInfo } from "./proxy";

// ── Status View (current rate limit snapshot) ──

interface StatusItem {
  label: string;
  value: string;
  icon: string;
}

export class RateLimitStatusProvider
  implements vscode.TreeDataProvider<StatusItem>
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private latest: RateLimitInfo | null = null;
  private proxyRunning = false;

  update(info: RateLimitInfo) {
    this.latest = info;
    this._onDidChange.fire();
  }

  setProxyStatus(running: boolean) {
    this.proxyRunning = running;
    this._onDidChange.fire();
  }

  getTreeItem(el: StatusItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${el.label}: ${el.value}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon(el.icon);
    item.tooltip = `${el.label}: ${el.value}`;
    return item;
  }

  getChildren(): StatusItem[] {
    const items: StatusItem[] = [];

    items.push({
      label: "Proxy",
      value: this.proxyRunning ? "Running" : "Stopped",
      icon: this.proxyRunning ? "debug-start" : "debug-stop",
    });

    if (!this.latest) {
      items.push({
        label: "Status",
        value: "Waiting for requests…",
        icon: "loading~spin",
      });
      return items;
    }

    const rl = this.latest.rateLimits;

    if (rl.requestsRemaining !== null && rl.requestsLimit !== null) {
      const pct =
        (parseInt(rl.requestsRemaining) / parseInt(rl.requestsLimit)) * 100;
      items.push({
        label: "Requests",
        value: `${rl.requestsRemaining} / ${rl.requestsLimit} (${pct.toFixed(0)}%)`,
        icon: pct < 20 ? "warning" : pct < 50 ? "info" : "pass",
      });
    }

    if (rl.tokensRemaining !== null && rl.tokensLimit !== null) {
      const pct =
        (parseInt(rl.tokensRemaining) / parseInt(rl.tokensLimit)) * 100;
      items.push({
        label: "Tokens",
        value: `${rl.tokensRemaining} / ${rl.tokensLimit} (${pct.toFixed(0)}%)`,
        icon: pct < 20 ? "warning" : pct < 50 ? "info" : "pass",
      });
    }

    if (rl.requestsReset) {
      items.push({
        label: "Requests Reset",
        value: rl.requestsReset,
        icon: "history",
      });
    }

    if (rl.tokensReset) {
      items.push({
        label: "Tokens Reset",
        value: rl.tokensReset,
        icon: "history",
      });
    }

    if (rl.retryAfter) {
      items.push({
        label: "Retry After",
        value: `${rl.retryAfter}s`,
        icon: "error",
      });
    }

    items.push({
      label: "Last Response",
      value: `${this.latest.method} ${this.latest.path} → ${this.latest.statusCode}`,
      icon: "globe",
    });

    items.push({
      label: "Last Updated",
      value: this.latest.timestamp.toLocaleTimeString(),
      icon: "clock",
    });

    return items;
  }
}

// ── History View (scrollable request log) ──

export class RequestHistoryProvider
  implements vscode.TreeDataProvider<RateLimitInfo>
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private history: RateLimitInfo[] = [];
  private maxItems = 100;

  add(info: RateLimitInfo) {
    this.history.unshift(info);
    if (this.history.length > this.maxItems) {
      this.history.pop();
    }
    this._onDidChange.fire();
  }

  clear() {
    this.history = [];
    this._onDidChange.fire();
  }

  getTreeItem(info: RateLimitInfo): vscode.TreeItem {
    const rl = info.rateLimits;
    const reqInfo =
      rl.requestsRemaining !== null
        ? ` | req: ${rl.requestsRemaining}/${rl.requestsLimit}`
        : "";
    const tokInfo =
      rl.tokensRemaining !== null
        ? ` | tok: ${rl.tokensRemaining}/${rl.tokensLimit}`
        : "";

    const label = `${info.statusCode} ${info.method} ${info.path}${reqInfo}${tokInfo}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.description = info.timestamp.toLocaleTimeString();

    if (info.statusCode === 429) {
      item.iconPath = new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("errorForeground")
      );
    } else if (info.statusCode >= 400) {
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("editorWarning.foreground")
      );
    } else {
      item.iconPath = new vscode.ThemeIcon("pass");
    }

    // Show full headers on hover
    const headerLines = Object.entries(info.headers)
      .filter(([k]) => k.toLowerCase().startsWith("x-ratelimit") || k.toLowerCase() === "retry-after")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    item.tooltip = new vscode.MarkdownString(
      `**${info.method} ${info.path}**\n\nStatus: ${info.statusCode}\nTime: ${info.timestamp.toLocaleString()}\n\n\`\`\`\n${headerLines}\n\`\`\``
    );

    return item;
  }

  getChildren(): RateLimitInfo[] {
    return this.history;
  }
}
