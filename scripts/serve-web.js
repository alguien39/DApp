/**
 * Sirve la carpeta web/ igual que Vercel: archivos estaticos + la funcion web/api/upload.js
 *   npm run web   ->  http://localhost:5173
 * Lee PINATA_JWT y ADMIN_ADDRESSES del .env (en Vercel van en Environment Variables).
 */
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 5173);
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

http
  .createServer(async (req, res) => {
    const ruta = decodeURIComponent(req.url.split("?")[0]);

    if (ruta.startsWith("/api/")) {
      const archivo = path.join(DIR, "api", `${path.basename(ruta)}.js`);
      if (!fs.existsSync(archivo)) return res.writeHead(404).end("No encontrado");
      let body = "";
      for await (const chunk of req) body += chunk;
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      // mismos helpers que da Vercel
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      return require(archivo)(req, res);
    }

    const archivo = path.join(DIR, ruta === "/" ? "index.html" : ruta);
    if (!archivo.startsWith(DIR) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      return res.writeHead(404).end("No encontrado");
    }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(archivo)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(archivo).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`BoletoTEC en http://localhost:${PORT}  (Ctrl+C para detener)`));
