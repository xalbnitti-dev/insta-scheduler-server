import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "fs-extra";

const router = Router();

// dir i upload-eve
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.ensureDirSync(UPLOAD_DIR);

// storage i thjeshtë
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

// POST /upload  (kthen URL publike)
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const appBase = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 10000}`;
    const publicUrl = `${appBase}/uploads/${path.basename(req.file.path)}`;
    return res.json({ url: publicUrl });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Upload error" });
  }
});

export default router;
