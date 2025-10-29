import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';

const app = express();

// --- CORS ---
// Mund ta kufizosh me origin: ['https://<projekti-yt>.vercel.app']
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// --- Uploads (disk) ---
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
// ❗ ZËVENDËSUAR: pa top-level await
fs.ensureDirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'file')),
});
const upload = multer({ storage });

// Shërbe skedarët e ngarkuar publikisht
app.use('/uploads', express.static(UPLOAD_DIR));

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- /upload ---
// PRANON fushën "image"
app.post('/upload', upload.single('image'), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const base =
    (process.env.APP_BASE_URL && process.env.APP_BASE_URL.replace(/\/+$/, '')) ||
    `http://localhost:${process.env.PORT || 5000}`;

  const publicUrl = `${base}/uploads/${encodeURIComponent(req.file.filename)}`;
  return res.json({
    url: publicUrl,
    filename: req.file.filename,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

// --- /posts/schedule ---
app.post('/posts/schedule', async (req: Request, res: Response) => {
  const { account, caption, imageUrl, when } = req.body || {};
  if (!account || !imageUrl || !when) {
    return res.status(400).json({ error: 'account, imageUrl, when janë të detyrueshme' });
  }

  // (këtu mund të shtosh ruajtje DB ose një queue)
  console.log('[SCHEDULE]', { account, when, imageUrl, caption: caption?.slice(0, 40) });

  return res.status(201).json({ ok: true });
});

// --- Error handler që të mos kthehet HTML ---
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('ERROR:', err);
  res.status(500).json({ error: err?.message || 'Server error' });
});

// --- Start ---
const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  const base =
    (process.env.APP_BASE_URL && process.env.APP_BASE_URL.replace(/\/+$/, '')) ||
    `http://localhost:${PORT}`;
  console.log('Public base:', base);
});
