import express from "express";
import cors from "cors";
import multer from "multer";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ==== uploads (servir publikisht, që IG ta marrë me HTTP/HTTPS) ====
const UP_DIR = path.join(__dirname, "uploads");
await fse.ensureDir(UP_DIR);
app.use("/uploads", express.static(UP_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    cb(null, base + ext);
  }
});
const upload = multer({ storage });

// ==== persistence (jobs.json) ====
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
await fse.ensureDir(DATA_DIR);
if (!(await fse.pathExists(JOBS_FILE))) {
  await fse.writeJSON(JOBS_FILE, { jobs: [] }, { spaces: 2 });
}
async function loadJobs() {
  return (await fse.readJSON(JOBS_FILE)).jobs || [];
}
async function saveJobs(jobs) {
  await fse.writeJSON(JOBS_FILE, { jobs }, { spaces: 2 });
}

// ==== config nga ENV ====
const BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
let IG_MAP = {};
try { IG_MAP = JSON.parse(process.env.IG_ACCOUNT_MAP || "{}"); } catch { IG_MAP = {}; }

// Timings për polling (mund t’i rregullosh në ENV nëse do)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);  // 3s
const POLL_MAX_MS      = Number(process.env.POLL_MAX_MS || 180000);     // 3 min (rrite nëse poston VIDEO)

// ==== helpers ====
function absUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (!BASE_URL) return u; // fallback relativ (jo ideale për IG)
  // p.sh. /uploads/x.jpg -> https://…/uploads/x.jpg
  return `${BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pollContainerReady(creationId, accessToken) {
  const started = Date.now();
  while (Date.now() - started < POLL_MAX_MS) {
    const u = new URL(`https://graph.facebook.com/v24.0/${creationId}`);
    u.searchParams.set("fields", "status_code,status");
    u.searchParams.set("access_token", accessToken);

    const res = await fetch(u, { method: "GET" });
    const js  = await res.json();
    if (!res.ok) {
      throw new Error(`IG container poll error: ${res.status} ${JSON.stringify(js)}`);
    }

    const code = (js.status_code || js.status || "").toUpperCase();
    // status_code zakonisht: IN_PROGRESS, FINISHED, ERROR
    if (code === "FINISHED" || code === "READY") return true;
    if (code === "ERROR") {
      throw new Error(`IG container ERROR: ${JSON.stringify(js)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`IG container timeout pas ${POLL_MAX_MS/1000}s`);
}

function isVideoUrl(url) {
  return /\.(mp4|mov|m4v|avi|webm)(\?|#|$)/i.test(url);
}

// Publikimi real në Instagram (me polling korrekt)
async function publishToInstagram({ account, caption, mediaUrl }) {
  const cfg = IG_MAP[account];
  if (!cfg?.ig_user_id || !cfg?.page_access_token) {
    throw new Error(`Missing IG mapping for account "${account}"`);
  }

  const finalUrl = absUrl(mediaUrl);
  if (!/^https?:\/\//i.test(finalUrl)) {
    throw new Error(`Media URL must be public HTTP(S): got "${mediaUrl}" -> "${finalUrl}"`);
  }

  // 1) krijo container (foto ose video)
  const isVideo = isVideoUrl(finalUrl);
  const bodyParams = new URLSearchParams();
  bodyParams.set("access_token", cfg.page_access_token);
  bodyParams.set("caption", caption || "");
  if (isVideo) {
    bodyParams.set("media_type", "VIDEO");
    bodyParams.set("video_url", finalUrl);
  } else {
    bodyParams.set("image_url", finalUrl);
  }

  const createRes = await fetch(`https://graph.facebook.com/v24.0/${cfg.ig_user_id}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyParams
  });
  const createJs = await createRes.json();
  if (!createRes.ok || !createJs.id) {
    throw new Error(`IG media error: ${createRes.status} ${JSON.stringify(createJs)}`);
  }
  const creationId = createJs.id;

  // 2) poll derisa container-i të jetë gati
  await pollContainerReady(creationId, cfg.page_access_token);

  // 3) publish
  const pubRes = await fetch(`https://graph.facebook.com/v24.0/${cfg.ig_user_id}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: creationId,
      access_token: cfg.page_access_token
    })
  });
  const pubJs = await pubRes.json();
  if (!pubRes.ok) {
    throw new Error(`IG publish error: ${pubRes.status} ${JSON.stringify(pubJs)}`);
  }
  return pubJs; // p.sh. { id: "<ig_media_id>" }
}

// ==== routes ====

// health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    baseUrl: BASE_URL || null,
    hasIGMap: !!Object.keys(IG_MAP).length,
    poll: { intervalMs: POLL_INTERVAL_MS, maxMs: POLL_MAX_MS }
  });
});

// upload single
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = BASE_URL ? `${BASE_URL}/uploads/${req.file.filename}` : `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname });
});

// upload multi
app.post("/upload-multi", upload.array("images", 200), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const files = req.files.map(f => ({
    url: BASE_URL ? `${BASE_URL}/uploads/${f.filename}` : `/uploads/${f.filename}`,
    name: f.originalname
  }));
  res.json({ files });
});

// schedule one (ruan + cron e ekzekuton)
app.post("/posts/schedule", async (req, res) => {
  const { account, caption, imageUrl, when } = req.body || {};
  if (!account || !imageUrl || !when) {
    return res.status(400).json({ error: "Missing account/imageUrl/when" });
  }
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    account,
    caption: caption || "",
    imageUrl,
    when: new Date(when).toISOString(),
    status: "scheduled",
    createdAt: new Date().toISOString(),
    lastError: null,
    ig: null
  };
  const jobs = await loadJobs();
  jobs.push(job);
  await saveJobs(jobs);
  console.log("[SCHEDULE ONE]", { id: job.id, account: job.account, when: job.when });
  res.json({ ok: true, id: job.id });
});

// list jobs
app.get("/posts", async (_req, res) => {
  const jobs = await loadJobs();
  res.json({ jobs });
});

// ==== cron modest (poll çdo 30s) ====
setInterval(async () => {
  try {
    const now = Date.now();
    const jobs = await loadJobs();
    let changed = false;

    for (const j of jobs) {
      if (j.status === "scheduled" && new Date(j.when).getTime() <= now) {
        try {
          console.log("[PUBLISH DUE]", { id: j.id, account: j.account, imageUrl: j.imageUrl });
          const result = await publishToInstagram({
            account: j.account,
            caption: j.caption,
            mediaUrl: j.imageUrl
          });
          j.status = "published";
          j.publishedAt = new Date().toISOString();
          j.lastError = null;
          j.ig = result;
          changed = true;
          console.log("[IG PUBLISH OK]", j.id, result);
        } catch (err) {
          j.status = "error";
          j.lastError = String(err?.message || err);
          changed = true;
          console.error("[IG PUBLISH FAIL]", j.id, j.lastError);
        }
      }
    }

    if (changed) await saveJobs(jobs);
  } catch (e) {
    console.error("CRON error:", e);
  }
}, 30_000);

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
