const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { createProxyMiddleware } = require("http-proxy-middleware");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3030", 10);
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:3006";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// WebSocket proxy for Socket.io
const wsProxy = createProxyMiddleware({
    target: backendUrl,
    changeOrigin: true,
    ws: true,
    logLevel: "warn",
});

app.prepare().then(() => {
    const server = createServer((req, res) => {
        const parsedUrl = parse(req.url, true);
        const { pathname } = parsedUrl;

        // Proxy Socket.io HTTP requests (polling fallback)
        if (pathname.startsWith("/api/socket.io")) {
            wsProxy(req, res);
            return;
        }

        // Let Next.js handle everything else
        handle(req, res, parsedUrl);
    });

    // Handle WebSocket upgrade for Socket.io
    server.on("upgrade", (req, socket, head) => {
        const { pathname } = parse(req.url, true);

        if (pathname.startsWith("/api/socket.io")) {
            wsProxy.upgrade(req, socket, head);
        } else {
            // Next.js doesn't use WebSocket by default, destroy unknown upgrades
            socket.destroy();
        }
    });

    server.listen(port, hostname, () => {
        console.log(`> Frontend ready on http://${hostname}:${port}`);
        console.log(`> WebSocket proxy to ${backendUrl}`);
    });
});
