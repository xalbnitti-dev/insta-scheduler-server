import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'node:path';
import url from 'node:url';

const app = express();
app.use(cors());
app.use(express.json());

// ---- directories
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
await fs.ensureDir(UPLOAD_DIR);

// serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1y', immutable: true }));

// ---- health
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- single upload (form field: image)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const upload = multer({ storage });

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const publicUrl = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url: publicUrl, file: req.file });
});

// ---- multi upload (form field: images - multiple)
app.post('/upload-multi', upload.array('images'), (req, res) => {
  const files = (req.files || []).map(f => ({
    name: f.originalname,
    url: `/uploads/${f.filename}`,
    size: f.size
  }));
  if (!files.length) return res.status(400).json({ error: 'No files' });
  res.json({ ok: true, files });
});

// ---- start
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
