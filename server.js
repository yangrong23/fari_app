const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;

// Load local development secrets without exposing them to the browser bundle.
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));

const port = Number(process.env.PORT || 4175);
const apiKey = process.env.DASHSCOPE_API_KEY;
const videoBaseUrl = (process.env.DASHSCOPE_VIDEO_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const modelName = process.env.DASHSCOPE_VIDEO_MODEL || "wan3.0-video";
const imageModelName = process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-3.0-pro";
const imageEndpoint = process.env.DASHSCOPE_IMAGE_ENDPOINT || "/api/v1/services/aigc/image-generation/generation";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4"
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return readBodyBuffer(req).then(buffer => buffer.toString("utf8"));
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > 24 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("Multipart boundary is missing.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headerText = body.subarray(headerStart, headerEnd).toString("utf8");
    const disposition = headerText.match(/Content-Disposition:.*?name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, contentStart);
    if (nextBoundary < 0) break;
    const contentEnd = nextBoundary - 2;
    if (disposition) {
      const name = disposition[1];
      const filename = disposition[2];
      const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      fields[name] = filename
        ? { filename, contentType: contentTypeMatch?.[1]?.trim() || "application/octet-stream", buffer: body.subarray(contentStart, contentEnd) }
        : body.subarray(contentStart, contentEnd).toString("utf8");
    }
    cursor = nextBoundary;
  }
  return fields;
}

async function uploadToDashScope(file, model = modelName) {
  const policyResponse = await callDashScope(`/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  const data = policyResponse.data;
  if (!data) throw new Error("DashScope upload policy was empty.");
  const key = `${data.upload_dir}/${Date.now()}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", data.oss_access_key_id);
  form.append("policy", data.policy);
  form.append("Signature", data.signature);
  form.append("x-oss-object-acl", data.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", data.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", new Blob([file.buffer], { type: file.contentType }), file.filename);
  const uploadResponse = await fetch(data.upload_host, { method: "POST", body: form });
  if (!uploadResponse.ok) throw new Error(`DashScope file upload failed with ${uploadResponse.status}.`);
  return { url: `oss://${key}`, filename: file.filename, expiresInHours: 48 };
}

async function callDashScope(endpoint, options = {}) {
  if (!apiKey) {
    const error = new Error("DASHSCOPE_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${videoBaseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error?.message || `DashScope request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function handleApi(req, res) {
  try {
    if (req.method === "POST" && req.url === "/api/upload") {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("multipart/form-data")) return sendJson(res, 400, { error: "Use multipart/form-data." });
      const fields = parseMultipart(await readBodyBuffer(req), contentType);
      const file = fields.file;
      if (!file?.buffer?.length) return sendJson(res, 400, { error: "A file is required." });
      if (file.buffer.length > 20 * 1024 * 1024) return sendJson(res, 400, { error: "Image must be 20MB or smaller." });
      const uploaded = await uploadToDashScope(file);
      return sendJson(res, 200, uploaded);
    }

    if (req.method === "POST" && req.url === "/api/video-synthesis") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "Prompt is required." });

      const payload = {
        model: body.model || "wan3.0-video",
        input: {
          prompt,
          media: Array.isArray(body.media) ? body.media : []
        },
        parameters: {
          resolution: body.resolution || "480P",
          ratio: body.ratio || "adaptive",
          duration: Number(body.duration || 10),
          prompt_extend: body.prompt_extend !== false
        }
      };

      const data = await callDashScope("/api/v1/services/aigc/video-generation/video-synthesis", {
        method: "POST",
        headers: {
          "X-DashScope-Async": "enable",
          ...(payload.input.media.some(media => media.url.startsWith("oss://")) ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && req.url === "/api/keyframe-generation") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "Prompt is required." });
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) return sendJson(res, 400, { error: "At least one reference image is required." });

      const payload = {
        model: body.model || imageModelName,
        input: {
          prompt,
          ref_images: images.map(url => ({ url }))
        },
        parameters: {
          n: Math.min(Math.max(Number(body.n) || 4, 1), 6),
          size: body.size || "1280*720",
          prompt_extend: body.prompt_extend !== true
        }
      };

      const data = await callDashScope(imageEndpoint, {
        method: "POST",
        headers: {
          "X-DashScope-Async": "enable",
          ...(images.some(url => url.startsWith("oss://")) ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      return sendJson(res, 200, data);
    }

    const taskMatch = req.url.match(/^\/api\/tasks\/([^/?#]+)/);
    if (req.method === "GET" && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const data = await callDashScope(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: "GET" });
      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, { error: "API route not found." });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.message || "Unexpected server error.",
      details: error.data
    });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fari video server running at http://127.0.0.1:${port}/`);
  console.log(`video generator: http://127.0.0.1:${port}/video-generator.html`);
});
