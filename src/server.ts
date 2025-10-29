import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import fse from "fs-extra";
import multer from "multer";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// --- Static uploads dir ---
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fse.mkdirpSync(UPLOAD_DIR);
}
app.use("/uploads", express.static(UPLOAD_DIR));

// --- Multer storage (typed) ---
const storage = multer.diskStorage({
  destination(
    _req: Request,
    _file: Express.Multer.File,
    cb: (error: Error | null, destination: string) => void
  ) {
    cb(null, UPLOAD_DIR);
  },
  filename(
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, filename: string) => void
  ) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base}_${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// --- Health ---
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- Upload endpoint ---
app.post(
  "/upload",
  upload.single("image"),
  (req: Request, res: Response, _next: NextFunction) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const baseUrl = process.env.APP_BASE_URL || "";
    const publicUrl = `${baseUrl.replace(/\/$/, "")}/uploads/${encodeURIComponent(
      req.file.filename
    )}`;
    return res.json({
      ok: true,
      file: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      },
      url: publicUrl
    });
  }
);

// --- Schedule endpoint (mock) ---
app.post("/posts/schedule", async (req: Request, res: Response) => {
  const { account, caption, imageUrl, when } = req.body as {
    account?: string;
    caption?: string;
    imageUrl?: string;
    when?: string;
  };

  if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
  if (!when) return res.status(400).json({ error: "when required" });

  // Këtu do të fusësh logjikën tënde reale për planifikim / postim.
  // Për tani thjesht kthejmë OK.
  return res.json({
    ok: true,
    scheduled: { account, caption, imageUrl, when }
  });
});

// --- Start server ---
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
