// 测试用静态服务：/ext/* → 插件源码目录，/libs/* → 测试用第三方库，/fake/* → 假 FMS 页面
// 用法：node tests/fake-fms/server.js   然后打开 http://localhost:5300/fake/index.html?page=bill
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const EXT = path.resolve(ROOT, "..", ".."); // 仓库根目录（插件源码）
const types = { ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".html": "text/html; charset=utf-8", ".json": "application/json" };

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let file = null;
    if (url.startsWith("/ext/")) file = path.join(EXT, url.slice(5));
    else if (url.startsWith("/libs/")) file = path.join(ROOT, url);
    else if (url.startsWith("/fake/")) file = path.join(ROOT, url);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
  })
  .listen(5300, () => console.log("test server on http://localhost:5300"));
