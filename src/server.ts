import express, { Request, Response } from "express";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import cron from "node-cron";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:10000";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "CHANGE_ME";

// ku ruajmë fajlat e uploaduar
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.ensureDirSync(UPLOAD_DIR);

// storage disk me emër unik
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

type Job = {
  id: string;
  account: string;
  caption: string;
  imageUrl: string;
  when: string; // ISO
  status: "pending" | "done" | "failed";
  attempts: number;
  lastError?: string;
};

const JOBS: Job[] = []; // In-memory demo (mund t’i ruash në Mongo/SQLite)

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

function ok(res: Response, body: any) {
  res.setHeader("Content-Type", "application/json");
  return res.status(200).send(JSON.stringify(body));
}
function bad(res: Response, code: number, msg: string) {
  return res.status(code).json({ error: msg });
}
function auth(req: Request): boolean {
  const h = req.headers["x-admin-key"] as string | undefined;
  return !!ADMIN_API_KEY && h === ADMIN_API_KEY;
}

// Health
app.get("/health", (_req, res) => ok(res, { ok: true }));

// MULTI UPLOAD
app.post("/upload-multi", upload.array("images", 100), (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const out = files.map((f) => ({
      name: f.originalname,
      url: `${APP_BASE_URL}/uploads/${path.basename(f.path)}`,
      size: f.size,
      type: f.mimetype,
    }));
    return ok(res, { files: out });
  } catch (e: any) {
    return bad(res, 500, e?.message || "Upload error");
  }
});

// BULK SCHEDULE
app.post("/posts/schedule-bulk", (req, res) => {
  if (!auth(req)) return bad(res, 401, "Unauthorized (x-admin-key missing/wrong)");

  const body = req.body || {};
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return bad(res, 400, "Provide jobs[]");

  const created: string[] = [];
  for (const j of jobs) {
    if (!j.imageUrl || !j.when) continue;
    const job: Job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      account: j.account || "aurora",
      caption: j.caption || "",
      imageUrl: j.imageUrl,
      when: j.when,
      status: "pending",
      attempts: 0,
    };
    JOBS.push(job);
    created.push(job.id);
  }
  return ok(res, { ok: true, created, total: JOBS.length });
});

// (OPTIONAL) List jobs – për debug
app.get("/jobs", (_req, res) => ok(res, { jobs: JOBS }));

// === CRON: çdo 1 minutë ekzekuton punët due ===
cron.schedule("* * * * *", async () => {
  const now = new Date();
  for (const job of JOBS) {
    if (job.status !== "pending") continue;
    const when = new Date(job.when);
    if (when > now) continue;

    try {
      // TODO: KËTU VËR THIRRJET E IG GRAPH API
      // 1) Krijo container (POST /{igUserId}/media ...)
      // 2) Pres/check status, pastaj /{igUserId}/media_publish
      // Për momentin, e simulojmë:
      console.log(`[PUBLISH] ${job.account} -> ${job.imageUrl}`);
      job.status = "done";
    } catch (err: any) {
      job.status = "failed";
      job.attempts += 1;
      job.lastError = err?.message || String(err);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
