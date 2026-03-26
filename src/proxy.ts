import * as http from "http";
import * as https from "https";
import * as tls from "tls";
import * as net from "net";
import { EventEmitter } from "events";
import { URL } from "url";

export interface RateLimitInfo {
  timestamp: Date;
  method: string;
  path: string;
  statusCode: number;
  headers: Record<string, string>;
  rateLimits: {
    requestsLimit: string | null;
    requestsRemaining: string | null;
    requestsReset: string | null;
    tokensLimit: string | null;
    tokensRemaining: string | null;
    tokensReset: string | null;
    retryAfter: string | null;
  };
}

export class AnthropicProxy extends EventEmitter {
  private server: http.Server | null = null;
  private port: number;
  private targetHosts: string[];

  constructor(port: number, targetHosts: string[] = ["api.anthropic.com"]) {
    super();
    this.port = port;
    this.targetHosts = targetHosts;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Handle regular HTTP requests (unlikely for Anthropic, but handle anyway)
        this.handleHttpRequest(req, res);
      });

      // Handle CONNECT method for HTTPS tunneling
      this.server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.emit("started", this.port);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.emit("stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private isTargetHost(hostname: string): boolean {
    return this.targetHosts.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    );
  }

  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const hostname = url.hostname;

    if (!this.isTargetHost(hostname)) {
      // Pass through non-target traffic
      this.forwardHttp(req, res, url);
      return;
    }

    // For target hosts, forward and capture response headers
    this.forwardAndCapture(req, res, url);
  }

  private forwardHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) {
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    req.pipe(proxyReq);
    proxyReq.on("error", () => res.end());
  }

  private forwardAndCapture(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.hostname },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      this.captureRateLimits(
        req.method || "GET",
        url.pathname,
        proxyRes.statusCode || 0,
        proxyRes.headers as Record<string, string>
      );
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    req.pipe(proxyReq);
    proxyReq.on("error", () => res.end());
  }

  /**
   * Handle CONNECT tunneling for HTTPS.
   *
   * For non-target hosts we just create a plain TCP tunnel.
   * For target hosts (api.anthropic.com) we perform a MitM:
   *  1. Tell the client the tunnel is established (200).
   *  2. Open our OWN TLS server socket to speak to the client.
   *  3. Parse the now-decrypted HTTP request coming from the client.
   *  4. Forward it over a real HTTPS connection to the target.
   *  5. Capture the response headers, then relay everything back.
   *
   * NOTE: Because we terminate TLS ourselves, the client (Claude Code)
   * must either trust our self-signed CA or have NODE_TLS_REJECT_UNAUTHORIZED=0.
   * The README explains how to set this up.
   */
  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ) {
    const [hostname, portStr] = (req.url || "").split(":");
    const port = parseInt(portStr, 10) || 443;

    if (!this.isTargetHost(hostname)) {
      // Plain TCP tunnel for non-target hosts
      const serverSocket = net.connect(port, hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on("error", () => clientSocket.end());
      clientSocket.on("error", () => serverSocket.end());
      return;
    }

    // --- MitM path for target hosts ---
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // We need a self-signed TLS context. Generate one at startup (see
    // generateSelfSignedCert helper). For simplicity this version uses
    // a pre-generated keypair shipped with the extension or generated on
    // first run. The real implementation is in extension.ts which calls
    // ensureCert().

    // For the initial implementation we use a simpler approach:
    // We act as an HTTP-level interceptor by reading raw data from the
    // client socket after the CONNECT handshake, forwarding it as an
    // HTTPS request, and relaying back.
    this.interceptTunnel(clientSocket, head, hostname, port);
  }

  /**
   * Simplified tunnel interception: read the raw TLS client-hello
   * from the client, open a real TLS connection to the target, and
   * splice the two together while sniffing the plaintext on the
   * server side.
   *
   * This approach does NOT require a self-signed CA — instead it
   * connects to the real server and captures the decrypted data
   * from the *server* side of the pipe by hooking into Node's
   * TLS socket events. However, the request/response bytes are
   * encrypted from the client's perspective so we can only capture
   * metadata (timing, sizes) unless we MitM.
   *
   * For full header capture we need the MitM approach. Here we
   * fall back to a metadata-only capture and advise the user to
   * use the HTTP_PROXY / HTTPS_PROXY env-var approach instead,
   * which avoids CONNECT entirely and gives us plaintext HTTP.
   */
  private interceptTunnel(
    clientSocket: net.Socket,
    head: Buffer,
    hostname: string,
    port: number
  ) {
    // For the recommended setup (HTTPS_PROXY=http://127.0.0.1:PORT),
    // Node's http module sends plain HTTP through the proxy, so the
    // handleHttpRequest path is used instead of CONNECT.
    //
    // If we still get a CONNECT (e.g. from curl or another client),
    // just tunnel and emit a metadata-only event.
    const serverSocket = net.connect(port, hostname, () => {
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    this.emit("tunnel", { hostname, port, timestamp: new Date() });
    serverSocket.on("error", () => clientSocket.end());
    clientSocket.on("error", () => serverSocket.end());
  }

  private captureRateLimits(
    method: string,
    path: string,
    statusCode: number,
    headers: Record<string, string>
  ) {
    const h = (name: string) =>
      headers[name] || headers[name.toLowerCase()] || null;

    const info: RateLimitInfo = {
      timestamp: new Date(),
      method,
      path,
      statusCode,
      headers: { ...headers },
      rateLimits: {
        requestsLimit: h("x-ratelimit-limit-requests"),
        requestsRemaining: h("x-ratelimit-remaining-requests"),
        requestsReset: h("x-ratelimit-reset-requests"),
        tokensLimit: h("x-ratelimit-limit-tokens"),
        tokensRemaining: h("x-ratelimit-remaining-tokens"),
        tokensReset: h("x-ratelimit-reset-tokens"),
        retryAfter: h("retry-after"),
      },
    };

    this.emit("rateLimit", info);
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}
