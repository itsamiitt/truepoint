const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5000;
const HOST = "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];

  if (urlPath === "/" || urlPath === "") {
    urlPath = "/index.html";
  }

  let filePath;
  if (urlPath === "/index.html") {
    filePath = path.join(__dirname, "index.html");
  } else if (urlPath.startsWith("/Guidelines/")) {
    filePath = path.join(__dirname, urlPath);
  } else if (urlPath.startsWith("/App-icons/")) {
    filePath = path.join(__dirname, urlPath);
  } else if (urlPath.startsWith("/logo/")) {
    filePath = path.join(__dirname, urlPath);
  } else {
    filePath = path.join(__dirname, urlPath);
  }

  filePath = path.normalize(filePath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`TruePoint Brand Kit server running at http://${HOST}:${PORT}`);
});
