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

// ===== env & admin keys (optional) =====
const ADMIN_KEYS = String(process.env.ADMIN_API_KEY || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function checkAdmin(req, res, next) {
  if (!ADMIN_KEYS.length) return next(); // no protection configured
  const provided = String(req.header("x-admin-key") || "").trim();
  if (ADMIN_KEYS.includes(provided)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ===== uploads setup =====
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

// ===== health =====
app.get("/health", (_req, res) => {
  res.json({ ok: true, uploads: "/uploads/*" });
});

// ===== upload (single) =====
app.post("/upload", checkAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const baseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/uploads/${req.file.filename}`
    : `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname });
});

// ===== upload (multi) =====
app.post("/upload-multi", checkAdmin, upload.array("images", 50), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const baseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const files = req.files.map(f => ({
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/uploads/${f.filename}` : `/uploads/${f.filename}`,
    name: f.originalname
  }));
  res.json({ files });
});

// ===== schedule one =====
app.post("/posts/schedule", checkAdmin, (req, res) => {
  const { account, caption, imageUrl, when } = req.body || {};
  if (!account || !imageUrl || !when) {
    return res.status(400).json({ error: "Missing account/imageUrl/when" });
  }
  // Këtu do lidhet IG publish. Për test, thjesht log + ok.
  console.log("[SCHEDULE ONE]", { account, when, imageUrl, caption });
  res.json({ ok: true });
});

// ===== bulk (multipart) =====
// fields: account, caption, times(JSON array of ISO); files: images[]
app.post("/bulk", checkAdmin, upload.array("images", 200), (req, res) => {
  const { account, caption } = req.body || {};
  let times = [];
  try { times = JSON.parse(req.body?.times || "[]"); } catch {}
  if (!account || !times.length) {
    return res.status(400).json({ error: "Missing account/times" });
  }

  const baseUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const urls = (req.files || []).map(f =>
    baseUrl ? `${baseUrl.replace(/\/+$/, "")}/uploads/${f.filename}` : `/uploads/${f.filename}`
  );

  // Pair (time, url) me radhë.
  const jobs = times.map((t, i) => ({
    when: t,
    imageUrl: urls[i] || urls[urls.length - 1] || null,
  }));

  console.log("[SCHEDULE BULK]", { account, count: jobs.length, caption });
  res.json({ ok: true, jobs });
});

// ===== start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
