import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import cron from 'node-cron';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { google } from 'googleapis';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* -------------------- CONFIG -------------------- */
const PORT = process.env.PORT || 10000; // Render e zë vetë
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';

// Mappo llogaritë (Page access tokens + IG user IDs)
const ACCOUNTS = {
  aurora: {
    pageAccessToken: process.env.PAGE_AURORA_ACCESS_TOKEN || '',
    igUserId: process.env.IG_AURORA_USER_ID || ''
  },
  novara: {
    pageAccessToken: process.env.PAGE_NOVARA_ACCESS_TOKEN || '',
    igUserId: process.env.IG_NOVARA_USER_ID || ''
  },
  selena: {
    pageAccessToken: process.env.PAGE_SELENA_ACCESS_TOKEN || '',
    igUserId: process.env.IG_SELENA_USER_ID || ''
  },
  cynara: {
    pageAccessToken: process.env.PAGE_CYNARA_ACCESS_TOKEN || '',
    igUserId: process.env.IG_CYNARA_USER_ID || ''
  }
};

// Upload dir
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
await fs.ensureDir(UPLOAD_DIR);

// Statics
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false }));

/* -------------------- DB (SQLite) -------------------- */
const db = new Database(path.join(process.cwd(), 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    caption TEXT,
    image_url TEXT NOT NULL,
    when_iso TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    tries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_when ON jobs(when_iso);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* -------------------- Multer (multi) -------------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'file', ext).replace(/[^a-z0-9_-]/gi, '_');
    const name = `${Date.now()}_${Math.floor(Math.random() * 1e6)}_${base}${ext || ''}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

/* -------------------- Helpers -------------------- */
const sha256File = async (p) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(p);
  return new Promise((resolve, reject) => {
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

const isImage = (file) => /^image\//.test(file.mimetype || '');
const isVideo = (file) => /^video\//.test(file.mimetype || '');

const insertJob = db.prepare(`
  INSERT INTO jobs (account, caption, image_url, when_iso, status)
  VALUES (@account, @caption, @image_url, @when_iso, 'queued')
`);
const selectDueJobs = db.prepare(`
  SELECT * FROM jobs
  WHERE status='queued' AND datetime(when_iso) <= datetime('now')
  ORDER BY when_iso ASC
  LIMIT 20
`);
const markDone = db.prepare(`UPDATE jobs SET status='done' WHERE id=?`);
const markFailed = db.prepare(`UPDATE jobs SET status='failed', tries=tries+1, last_error=? WHERE id=?`);

/* -------------------- Health -------------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* -------------------- Upload multi -------------------- */
app.post('/upload-multi', upload.array('images', 100), async (req, res) => {
  try {
    const files = req.files || [];
    const out = [];
    for (const f of files) {
      const hash = await sha256File(f.path);
      // dedup
      const ins = db.prepare(`INSERT OR IGNORE INTO assets(hash, path) VALUES(?, ?)`);
      ins.run(hash, f.filename);

      out.push({
        name: f.originalname,
        url: `${APP_BASE_URL}/uploads/${f.filename}`,
        type: isVideo(f) ? 'video' : 'image'
      });
    }
    res.json({ files: out });
  } catch (e) {
    console.error('upload-multi error', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/* -------------------- Bulk schedule -------------------- */
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!ADMIN_API_KEY || key === ADMIN_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Body: { jobs: [{account, caption, imageUrl, when}, ...] }
app.post('/posts/schedule-bulk', requireAdmin, (req, res) => {
  try {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    if (!jobs.length) return res.status(400).json({ error: 'Empty jobs' });

    const tx = db.transaction((rows) => {
      for (const j of rows) {
        if (!j.account || !j.imageUrl || !j.when) throw new Error('Missing fields');
        // sanity
        const acc = ACCOUNTS[j.account];
        if (!acc?.pageAccessToken || !acc?.igUserId)
          throw new Error(`Account ${j.account} not configured`);
        insertJob.run({
          account: j.account,
          caption: j.caption || '',
          image_url: j.imageUrl,
          when_iso: new Date(j.when).toISOString()
        });
      }
    });
    tx(jobs);

    res.json({ ok: true, count: jobs.length });
  } catch (e) {
    console.error('schedule-bulk error', e);
    res.status(400).json({ error: e.message || 'Invalid' });
  }
});

/* -------------------- Google Drive ingest --------------------
   Body: { folderId: "...", max: 20 }
   Kërkon env:
   - GDRIVE_CLIENT_EMAIL
   - GDRIVE_PRIVATE_KEY  (ruaje me \n të zëvendësuara si newline në Render)
--------------------------------------------------------------*/
app.post('/ingest/gdrive', requireAdmin, async (req, res) => {
  try {
    const { folderId, max = 50 } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });

    const auth = new google.auth.JWT(
      process.env.GDRIVE_CLIENT_EMAIL,
      null,
      (process.env.GDRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/drive.readonly']
    );
    const drive = google.drive({ version: 'v3', auth });

    const files = [];
    let pageToken = undefined;

    while (files.length < max) {
      const { data } = await drive.files.list({
        q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed=false`,
        fields: 'files(id,name,mimeType),nextPageToken',
        pageSize: Math.min(100, max - files.length),
        pageToken
      });
      files.push(...(data.files || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    const saved = [];
    for (const f of files) {
      // shkarko në server
      const destName = `${Date.now()}_${f.id}_${f.name.replace(/[^a-z0-9_.-]/gi, '_')}`;
      const destPath = path.join(UPLOAD_DIR, destName);

      const resp = await drive.files.get(
        { fileId: f.id, alt: 'media' },
        { responseType: 'stream' }
      );
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        resp.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      // dedup
      const hash = await sha256File(destPath);
      const ins = db.prepare(`INSERT OR IGNORE INTO assets(hash, path) VALUES(?, ?)`);
      ins.run(hash, destName);

      saved.push({
        name: f.name,
        url: `${APP_BASE_URL}/uploads/${destName}`,
        type: (f.mimeType || '').startsWith('video/') ? 'video' : 'image'
      });
    }

    res.json({ ok: true, count: saved.length, files: saved });
  } catch (e) {
    console.error('ingest gdrive error', e?.response?.data || e);
    res.status(500).json({ error: 'gdrive ingest failed' });
  }
});

/* -------------------- IG publish -------------------- */
async function publishToInstagram({ account, caption, mediaUrl }) {
  const cfg = ACCOUNTS[account];
  if (!cfg?.pageAccessToken || !cfg?.igUserId)
    throw new Error(`Account ${account} not configured`);

  const token = cfg.pageAccessToken;
  const userId = cfg.igUserId;

  // vendos tipin
  const isVid = /\.(mp4|mov|m4v|webm)$/i.test(mediaUrl);

  // 1) Create container
  const createUrl = `https://graph.facebook.com/v20.0/${userId}/media`;
  const payload = isVid
    ? { media_type: 'VIDEO', video_url: mediaUrl, caption }
    : { image_url: mediaUrl, caption };

  const { data: created } = await axios.post(createUrl, payload, {
    params: { access_token: token }
  });

  if (!created?.id) throw new Error('Failed to create media container');

  // 2) Publish
  const publishUrl = `https://graph.facebook.com/v20.0/${userId}/media_publish`;
  const { data: pub } = await axios.post(publishUrl, null, {
    params: { creation_id: created.id, access_token: token }
  });

  if (!pub?.id) throw new Error('Failed to publish media');
  return pub.id;
}

/* -------------------- Scheduler (1×/min) -------------------- */
cron.schedule('* * * * *', async () => {
  const due = selectDueJobs.all();
  if (!due.length) return;

  for (const j of due) {
    try {
      console.log('[PUBLISH]', j.id, j.account, j.image_url);
      await publishToInstagram({
        account: j.account,
        caption: j.caption || '',
        mediaUrl: j.image_url
      });
      markDone.run(j.id);
      console.log('[DONE]', j.id);
    } catch (e) {
      console.error('[FAIL]', j.id, e?.response?.data || e.message);
      markFailed.run(String(e?.response?.data?.error?.message || e.message), j.id);
    }
  }
});

/* -------------------- Util endpoints -------------------- */
app.get('/debug/jobs', (_req, res) => {
  const all = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all();
  res.json(all);
});

/* -------------------- Start -------------------- */
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Uploads at', `${APP_BASE_URL}/uploads/...`);
});
