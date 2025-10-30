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

// ---- health
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- upload (single)
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const baseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/uploads/${req.file.filename}` : `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname });
});

// ---- upload (multi)
app.post("/upload-multi", upload.array("images", 200), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const baseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const files = req.files.map(f => ({
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/uploads/${f.filename}` : `/uploads/${f.filename}`,
    name: f.originalname
  }));
  res.json({ files });
});

// ---- schedule ONE (ruaj në jobs.json)
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

// ---- list jobs (për kontroll)
app.get("/posts", async (_req, res) => {
  const jobs = await loadJobs();
  res.json({ jobs });
});

// ---- CRON modest (poll çdo 30s)
setInterval(async () => {
  try {
    const now = Date.now();
    const jobs = await loadJobs();
    let changed = false;

    for (const j of jobs) {
      if (j.status === "scheduled" && new Date(j.when).getTime() <= now) {
        try {
          // >>> HAPI #2 këtu: thirre Instagram Graph API për të publikuar <<<
          console.log("[PUBLISH DUE]", { id: j.id, account: j.account, imageUrl: j.imageUrl });

          // Simulo sukses
          j.status = "published";
          j.publishedAt = new Date().toISOString();
          j.lastError = null;
          changed = true;
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
