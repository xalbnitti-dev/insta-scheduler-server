import path from "node:path";
import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import fse from "fs-extra";

/** ----------------- ENV ----------------- */
const PORT = Number(process.env.PORT || 5000);
// URL publike e serverit (Render): p.sh. https://insta-scheduler-server.onrender.com
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
// (opsionale) kufizo CORS vetëm te Vercel domain-i yt
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN; // p.sh. https://insta-admin.vercel.app

/** ----------------- APP ----------------- */
const app = express();

// CORS
app.use(
  cors(
    FRONTEND_ORIGIN
      ? { origin: [FRONTEND_ORIGIN], credentials: false }
      : {} // prano të gjitha origjinat nëse s'është vendosur
  )
);

// JSON body
app.use(express.json({ limit: "10mb" }));

/** ----------------- UPLOADS ----------------- */
// uploads/ brenda projektit të builduar (dist -> ..)
const uploadsDir = path.resolve(__dirname, "..", "uploads");
fse.ensureDirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    cb(new Error("Lejohen vetëm imazhe."));
  },
});

// servirimi i skedarëve publikë
app.use("/uploads", express.static(uploadsDir, { index: false, maxAge: "365d" }));

/** ----------------- ROUTES ----------------- */

// health
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// upload
app.post("/upload", upload.single("image"), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "S’u mor asnjë file." });
    }
    if (!APP_BASE_URL) {
      return res.status(500).json({ error: "APP_BASE_URL mungon në server." });
    }
    const url = `${APP_BASE_URL}/uploads/${req.file.filename}`;
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Upload error" });
  }
});

// schedule (dummy – thjesht kthen sukses; këtu lidhet logjika jote)
app.post("/posts/schedule", async (req: Request, res: Response) => {
  try {
    const { account, caption, imageUrl, when } = req.body || {};
    if (!account) return res.status(400).json({ error: "Mungon account." });
    if (!imageUrl) return res.status(400).json({ error: "Mungon imageUrl." });
    if (!when) return res.status(400).json({ error: "Mungon koha e publikimit." });

    // këtu mund të ruash në DB ose të krijosh një cron/job queue
    // për shembull tani thjesht e kthejmë si OK:
    return res.json({
      ok: true,
      scheduled: { account, caption: caption || "", imageUrl, when },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Scheduling error" });
  }
});

// 404 JSON
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
