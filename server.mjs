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

// ---- uploads
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

// ---- persistence (jobs.json)
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
await fse.ensureDir(DATA_DIR);
if (!(await fse.pathExists(JOBS_FILE))) await fse.writeJSON(JOBS_FILE, { jobs: [] }, { spaces: 2 });

async function loadJobs() {
  return (await fse.readJSON(JOBS_FILE)).jobs || [];
}
async function saveJobs(jobs) {
  await fse.writeJSON(JOBS_FILE, { jobs }, { spaces: 2 });
}

// ---- IG account map nga env
let IG_MAP = {};
try {
  IG_MAP = JSON.parse(process.env.IG_ACCOUNT_MAP || "{}");
} catch {
  IG_MAP = {};
}

// ---- helpers
const BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

// publish image në IG
async function publishToInstagram({ account, caption, imageUrl }) {
  const cfg = IG_MAP[account];
  if (!cfg?.ig_user_id || !cfg?.page_access_token) {
    throw new Error(`Missing IG mapping for account "${account}"`);
  }
  // 1) Krijo media
  const mediaRes = await fetch(`https://graph.facebook.com/v24.0/${cfg.ig_user_id}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      image_url: imageUrl,
      caption: caption || "",
      access_token: cfg.page_access_token
    })
  });
  const mediaJson = await mediaRes.json();
  if (!mediaRes.ok) {
    throw new Error(`IG media error: ${mediaRes.status} ${JSON.stringify(mediaJson)}`);
  }
  const creationId = mediaJson.id;

  // 2) Publiko
  const pubRes = await fetch(`https://graph.facebook.com/v24.0/${cfg.ig_user_id}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: creationId,
      access_token: cfg.page_access_token
    })
  });
  const pubJson = await pubRes.json();
  if (!pubRes.ok) {
    throw new Error(`IG publish error: ${pubRes.status} ${JSON.stringify(pubJson)}`);
  }
  return pubJson; // p.sh. { id: "...post id..." }
}

// ---- health
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), baseUrl: BASE_URL || null, hasIGMap: !!Object.keys(IG_MAP).length });
});

// ---- upload (single)
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = BASE_URL ? `${BASE_URL}/uploads/${req.file.filename}` : `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname });
});

// ---- upload (multi)
app.post("/upload-multi", upload.array("images", 200), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const files = req.files.map(f => ({
    url: BASE_URL ? `${BASE_URL}/uploads/${f.filename}` : `/uploads/${f.filename}`,
    name: f.originalname
  }));
  res.json({ files });
});

// ---- schedule ONE
app.post("/posts/schedule", async (req, res) => {
  const { account, caption, imageUrl, when } = req.body || {};
  if (!account || !imageUrl || !when) return res.status(400).json({ error: "Missing account/imageUrl/when" });

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    account,
    caption: caption || "",
    imageUrl,
    when: new Date(when).toISOString(),
    status: "scheduled",
    createdAt: new Date().toISOString(),
    lastError: null
  };

  const jobs = await loadJobs();
  jobs.push(job);
  await saveJobs(jobs);

  console.log("[SCHEDULE ONE]", { id: job.id, account: job.account, when: job.when });
  res.json({ ok: true, id: job.id });
});

// ---- list jobs
app.get("/posts", async (_req, res) => {
  const jobs = await loadJobs();
  res.json({ jobs });
});

// ---- CRON: kontrollon çdo 30s dhe publikon realisht në IG
setInterval(async () => {
  try {
    const now = Date.now();
    const jobs = await loadJobs();
    let changed = false;

    for (const j of jobs) {
      if (j.status === "scheduled" && new Date(j.when).getTime() <= now) {
        try {
          // publikim real:
          const result = await publishToInstagram({
            account: j.account,
            caption: j.caption,
            imageUrl: j.imageUrl
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

// ---- start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
