import * as http from "http";
import * as https from "https";
import * as tls from "tls";
import * as net from "net";
import { EventEmitter } from "events";
import { URL } from "url";
import * as selfsigned from "selfsigned";

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
    inputTokensLimit: string | null;
    inputTokensRemaining: string | null;
    inputTokensReset: string | null;
    outputTokensLimit: string | null;
    outputTokensRemaining: string | null;
    outputTokensReset: string | null;
    retryAfter: string | null;
  };
}

export class AnthropicProxy extends EventEmitter {
  private server: http.Server | null = null;
  private port: number;
  private targetHosts: string[];
  private tlsKey: string = "";
  private tlsCert: string = "";

  constructor(port: number, targetHosts: string[] = ["api.anthropic.com"]) {
    super();
    this.port = port;
    this.targetHosts = targetHosts;
  }

  async start(): Promise<void> {
    // Generate self-signed cert with SANs for all target hosts
    const altNames = this.targetHosts.map((h) => ({ type: 2 as const, value: h }));
    const notAfterDate = new Date();
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: this.targetHosts[0] }],
      {
        keySize: 2048,
        algorithm: "sha256",
        notAfterDate,
        extensions: [
          { name: "subjectAltName", altNames },
        ],
      }
    );
    this.tlsKey = pems.private;
    this.tlsCert = pems.cert;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        // Emit 'stopped' whenever the server closes, regardless of cause
        this.server!.on("close", () => {
          this.server = null;
          this.emit("stopped");
        });
        this.emit("started", this.port);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      // Resolve once the 'close' handler (registered in start) has fired
      this.server.once("close", () => resolve());
      if (this.server.listening) {
        this.server.close();
      }
      // If not listening but server exists, it's already closing — once("close") will resolve us
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
      this.forwardHttp(req, res, url);
      return;
    }

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
   * For non-target hosts: plain TCP tunnel (passthrough).
   * For target hosts (api.anthropic.com): TLS MitM to decrypt,
   * parse HTTP, capture rate-limit headers, and relay responses.
   *
   * The client must have NODE_TLS_REJECT_UNAUTHORIZED=0 set
   * because we terminate TLS with a self-signed certificate.
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

    // --- TLS MitM for target hosts ---
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const secureContext = tls.createSecureContext({
      key: this.tlsKey,
      cert: this.tlsCert,
    });

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
    });

    if (head.length > 0) {
      tlsSocket.unshift(head);
    }

    // Create a temporary HTTP server and feed the decrypted TLS
    // socket into it so Node's HTTP parser handles framing.
    const interceptServer = http.createServer((req, res) => {
      const path = req.url || "/";
      const options: https.RequestOptions = {
        hostname,
        port,
        path,
        method: req.method,
        headers: { ...req.headers, host: hostname },
      };

      const proxyReq = https.request(options, (proxyRes) => {
        this.captureRateLimits(
          req.method || "GET",
          path,
          proxyRes.statusCode || 0,
          proxyRes.headers as Record<string, string>
        );
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      });

      req.pipe(proxyReq);
      proxyReq.on("error", () => {
        res.statusCode = 502;
        res.end("Bad Gateway");
      });
    });

    // Emit the TLS socket as a new connection on the HTTP server
    interceptServer.emit("connection", tlsSocket);

    tlsSocket.on("error", () => clientSocket.destroy());
    tlsSocket.on("close", () => interceptServer.close());
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
        requestsLimit: h("anthropic-ratelimit-requests-limit"),
        requestsRemaining: h("anthropic-ratelimit-requests-remaining"),
        requestsReset: h("anthropic-ratelimit-requests-reset"),
        tokensLimit: h("anthropic-ratelimit-tokens-limit"),
        tokensRemaining: h("anthropic-ratelimit-tokens-remaining"),
        tokensReset: h("anthropic-ratelimit-tokens-reset"),
        inputTokensLimit: h("anthropic-ratelimit-input-tokens-limit"),
        inputTokensRemaining: h("anthropic-ratelimit-input-tokens-remaining"),
        inputTokensReset: h("anthropic-ratelimit-input-tokens-reset"),
        outputTokensLimit: h("anthropic-ratelimit-output-tokens-limit"),
        outputTokensRemaining: h("anthropic-ratelimit-output-tokens-remaining"),
        outputTokensReset: h("anthropic-ratelimit-output-tokens-reset"),
        retryAfter: h("retry-after"),
      },
    };

    this.emit("rateLimit", info);
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}
