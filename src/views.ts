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
  private rlHeaders: Record<string, string> = {};
  private proxyRunning = false;

  update(info: RateLimitInfo) {
    this.latest = info;
    const incoming = Object.fromEntries(
      Object.entries(info.headers).filter(([k]) => k.startsWith("anthropic-ratelimit") || k === "retry-after")
    );
    if (Object.keys(incoming).length > 0) {
      this.rlHeaders = { ...this.rlHeaders, ...incoming };
    }
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

    const h = this.rlHeaders;
    const fmtReset = (ts: string, includeDate = false) => {
      const d = new Date(parseInt(ts) * 1000);
      return includeDate
        ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : d.toLocaleTimeString();
    };
    const usageIcon = (pct: number) => pct > 80 ? "warning" : pct > 50 ? "info" : "pass";

    // Unified rate limit headers (Claude.ai account-based billing)
    if (h["anthropic-ratelimit-unified-status"]) {
      const s = h["anthropic-ratelimit-unified-status"];
      items.push({ label: "Status", value: s, icon: s === "allowed" ? "pass" : "error" });
    }

    if (h["anthropic-ratelimit-unified-5h-utilization"] !== undefined) {
      const pct = parseFloat(h["anthropic-ratelimit-unified-5h-utilization"]) * 100;
      items.push({ label: "5h Usage", value: `${pct.toFixed(0)}%`, icon: usageIcon(pct) });
    }

    if (h["anthropic-ratelimit-unified-7d-utilization"] !== undefined) {
      const pct = parseFloat(h["anthropic-ratelimit-unified-7d-utilization"]) * 100;
      items.push({ label: "7d Usage", value: `${pct.toFixed(0)}%`, icon: usageIcon(pct) });
    }

    if (h["anthropic-ratelimit-unified-5h-reset"]) {
      items.push({ label: "5h Reset", value: fmtReset(h["anthropic-ratelimit-unified-5h-reset"]), icon: "history" });
    }

    if (h["anthropic-ratelimit-unified-7d-reset"]) {
      items.push({ label: "7d Reset", value: fmtReset(h["anthropic-ratelimit-unified-7d-reset"], true), icon: "history" });
    }

    if (h["anthropic-ratelimit-unified-overage-status"]) {
      items.push({ label: "Overage", value: h["anthropic-ratelimit-unified-overage-status"], icon: "info" });
    }

    // Traditional API key rate limit headers (fallback)
    if (h["anthropic-ratelimit-requests-remaining"] && h["anthropic-ratelimit-requests-limit"]) {
      const rem = parseInt(h["anthropic-ratelimit-requests-remaining"]);
      const lim = parseInt(h["anthropic-ratelimit-requests-limit"]);
      const pct = (rem / lim) * 100;
      items.push({ label: "Requests", value: `${rem} / ${lim} (${pct.toFixed(0)}%)`, icon: usageIcon(100 - pct) });
    }

    if (h["retry-after"]) {
      items.push({ label: "Retry After", value: `${h["retry-after"]}s`, icon: "error" });
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
    if (info.path.startsWith("/api/event_logging/")) {
      return;
    }
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
      .filter(([k]) => k.toLowerCase().startsWith("anthropic-ratelimit") || k.toLowerCase() === "retry-after")
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
