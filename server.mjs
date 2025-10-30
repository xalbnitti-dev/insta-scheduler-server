import express from "express";
import cors from "cors";
import multer from "multer";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

// Node 20 ka fetch global
const GRAPH_V = process.env.FB_GRAPH_VERSION || "v24.0";

// IG_ACCOUNT_MAP = JSON string me mapping të llogarive në token + ig_user_id.
// Shembull vlerë ENV:
// {"aurora":{"ig_user_id":"17841476745254762","page_access_token":"EAAX..."},
//  "novara":{"ig_user_id":"17841476962485998","page_access_token":"EAAX..."}}
const IG_ACCOUNT_MAP = safeParseJSON(process.env.IG_ACCOUNT_MAP || "{}");

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

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

// ---- helpers
function baseUrl() {
  return (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
}

async function publishToInstagram({ account, imageUrl, caption }) {
  const acct = IG_ACCOUNT_MAP[account];
  if (!acct?.ig_user_id || !acct?.page_access_token) {
    throw new Error(`Missing IG mapping for account "${account}"`);
  }
  const igId = acct.ig_user_id;
  const token = acct.page_access_token;

  // 1) Create container
  const createUrl = `https://graph.facebook.com/${GRAPH_V}/${igId}/media`;
  const createParams = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || "",
    access_token: token
  });

  const createRes = await fetch(createUrl, { method: "POST", body: createParams });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) {
    throw new Error(`Create media failed: ${JSON.stringify(createJson)}`);
  }

  // 2) Publish container
  const publishUrl = `https://graph.facebook.com/${GRAPH_V}/${igId}/media_publish`;
  const pubParams = new URLSearchParams({
    creation_id: createJson.id,
    access_token: token
  });
  const pubRes = await fetch(publishUrl, { method: "POST", body: pubParams });
  const pubJson = await pubRes.json();
  if (!pubRes.ok || !pubJson.id) {
    throw new Error(`Publish failed: ${JSON.stringify(pubJson)}`);
  }

  return { creation_id: createJson.id, media_id: pubJson.id };
}

// ---- health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    graph_version: GRAPH_V,
    accounts_configured: Object.keys(IG_ACCOUNT_MAP)
  });
});

// ---- upload (single)
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const bu = baseUrl();
  const url = bu ? `${bu}/uploads/${req.file.filename}` : `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname });
});

// ---- upload (multi)
app.post("/upload-multi", upload.array("images", 200), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const bu = baseUrl();
  const files = req.files.map(f => ({
    url: bu ? `${bu}/uploads/${f.filename}` : `/uploads/${f.filename}`,
    name: f.originalname
  }));
  res.json({ files });
});

// ---- schedule ONE
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

// ---- force publish now (debug): POST /debug/publish-now {id}
app.post("/debug/publish-now", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });
  const jobs = await loadJobs();
  const j = jobs.find(x => x.id === id);
  if (!j) return res.status(404).json({ error: "Job not found" });

  try {
    const info = await publishToInstagram(j);
    j.status = "published";
    j.publishedAt = new Date().toISOString();
    j.lastError = null;
    await saveJobs(jobs);
    console.log("[PUBLISH NOW]", { id: j.id, account: j.account, info });
    res.json({ ok: true, info });
  } catch (err) {
    j.status = "error";
    j.lastError = String(err?.message || err);
    await saveJobs(jobs);
    console.error("[PUBLISH FAIL]", j.id, j.lastError);
    res.status(500).json({ error: j.lastError });
  }
});

// ---- CRON: check every 30s
setInterval(async () => {
  try {
    const now = Date.now();
    const jobs = await loadJobs();
    let changed = false;

    for (const j of jobs) {
      if (j.status === "scheduled" && new Date(j.when).getTime() <= now) {
        try {
          const info = await publishToInstagram(j);
          j.status = "published";
          j.publishedAt = new Date().toISOString();
          j.lastError = null;
          changed = true;
          console.log("[PUBLISH DUE]", { id: j.id, account: j.account, info });
        } catch (err) {
          j.status = "error";
          j.lastError = String(err?.message || err);
          changed = true;
          console.error("[PUBLISH FAIL]", j.id, j.lastError);
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
