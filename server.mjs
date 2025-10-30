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

/* ---------- CORS (lejo x-admin-key) ---------- */
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

/* ---------- CONFIG ---------- */
const PORT = process.env.PORT || 10000;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

/* 
  Admin keys:
  - ADMIN_API_KEY   (single)
  - ose ADMIN_API_KEYS (comma-separated)
  Header-ët dhe env-ët pastrohen me trim() para krahasimit.
*/
const adminKeyEnv = (process.env.ADMIN_API_KEYS || process.env.ADMIN_API_KEY || '')
  .split(',')
  .map(s => (s || '').trim())
  .filter(Boolean);

function isAuthorized(req) {
  const header = (req.headers['x-admin-key'] || '').toString().trim();
  if (!adminKeyEnv.length) return true;             // nëse s’ke vendos asnjë key, lejo (dev)
  if (!header) return false;
  return adminKeyEnv.some(k => k === header);
}

function requireAdmin(req, res, next) {
  if (isAuthorized(req)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

/* ---------- Accounts (env) ---------- */
const ACCOUNTS = {
  aurora: {
    pageAccessToken: (process.env.PAGE_AURORA_ACCESS_TOKEN || '').trim(),
    igUserId: (process.env.IG_AURORA_USER_ID || '').trim(),
  },
  novara: {
    pageAccessToken: (process.env.PAGE_NOVARA_ACCESS_TOKEN || '').trim(),
    igUserId: (process.env.IG_NOVARA_USER_ID || '').trim(),
  },
  selena: {
    pageAccessToken: (process.env.PAGE_SELENA_ACCESS_TOKEN || '').trim(),
    igUserId: (process.env.IG_SELENA_USER_ID || '').trim(),
  },
  cynara: {
    pageAccessToken: (process.env.PAGE_CYNARA_ACCESS_TOKEN || '').trim(),
    igUserId: (process.env.IG_CYNARA_USER_ID || '').trim(),
  },
};

/* ---------- Upload dir & static ---------- */
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
await fs.ensureDir(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false }));

/* ---------- DB (SQLite) ---------- */
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
const markDone   = db.prepare(`UPDATE jobs SET status='done' WHERE id=?`);
const markFailed = db.prepare(`UPDATE jobs SET status='failed', tries=tries+1, last_error=? WHERE id=?`);

/* ---------- Multer (multi) ---------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'file', ext).replace(/[^a-z0-9_-]/gi, '_');
    const name = `${Date.now()}_${Math.floor(Math.random()*1e6)}_${base}${ext || ''}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

/* ---------- Helpers ---------- */
const sha256File = async (p) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(p);
  return new Promise((resolve, reject) => {
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

const isVideoUrl = (u) => /\.(mp4|mov|m4v|webm)$/i.test(u || '');

/* ---------- Health & Debug ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/debug/headers', (req, res) => {
  res.json({
    sawHeader: (req.headers['x-admin-key'] || null),
    expectedKeysCount: adminKeyEnv.length,
    expectedKeysPreview: adminKeyEnv.map(k => `${k.slice(0,3)}...${k.slice(-3)}`),
  });
});

app.get('/debug/jobs', (_req, res) => {
  const all = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all();
  res.json(all);
});

/* ---------- Upload multi ---------- */
app.post('/upload-multi', upload.array('images', 100), async (req, res) => {
  try {
    const files = req.files || [];
    const out = [];
    for (const f of files) {
      const hash = await sha256File(f.path);
      db.prepare(`INSERT OR IGNORE INTO assets(hash, path) VALUES(?, ?)`).run(hash, f.filename);
      out.push({
        name: f.originalname,
        url: `${APP_BASE_URL}/uploads/${f.filename}`,
        type: isVideoUrl(f.filename) ? 'video' : 'image'
      });
    }
    res.json({ files: out });
  } catch (e) {
    console.error('upload-multi error', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/* ---------- Bulk schedule ---------- */
// Body: { jobs: [{ account, caption, imageUrl, when }, ...] }
app.post('/posts/schedule-bulk', requireAdmin, (req, res) => {
  try {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    if (!jobs.length) return res.status(400).json({ error: 'Empty jobs' });

    const tx = db.transaction((rows) => {
      for (const j of rows) {
        const account = (j.account || '').trim();
        const imageUrl = (j.imageUrl || '').trim();
        const when = new Date(j.when || '').toISOString();

        if (!account || !imageUrl || !when) throw new Error('Missing fields');
        const acc = ACCOUNTS[account];
        if (!acc?.pageAccessToken || !acc?.igUserId)
          throw new Error(`Account ${account} not configured`);

        insertJob.run({
          account,
          caption: j.caption || '',
          image_url: imageUrl,
          when_iso: when
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

/* ---------- Google Drive ingest (opsionale) ---------- */
// Body: { folderId: "...", max: 50 }
app.post('/ingest/gdrive', requireAdmin, async (req, res) => {
  try {
    const { folderId, max = 50 } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId required' });

    const clientEmail = (process.env.GDRIVE_CLIENT_EMAIL || '').trim();
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    if (!clientEmail || !privateKey) return res.status(400).json({ error: 'gdrive creds missing' });

    const auth = new google.auth.JWT(
      clientEmail, null, privateKey, ['https://www.googleapis.com/auth/drive.readonly']
    );
    const drive = google.drive({ version: 'v3', auth });

    const files = [];
    let pageToken;
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
      const destName = `${Date.now()}_${f.id}_${(f.name || 'file').replace(/[^a-z0-9_.-]/gi, '_')}`;
      const destPath = path.join(UPLOAD_DIR, destName);

      const resp = await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'stream' });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        resp.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      const hash = await sha256File(destPath);
      db.prepare(`INSERT OR IGNORE INTO assets(hash, path) VALUES(?, ?)`).run(hash, destName);

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

/* ---------- IG publish ---------- */
async function publishToInstagram({ account, caption, mediaUrl }) {
  const cfg = ACCOUNTS[account];
  if (!cfg?.pageAccessToken || !cfg?.igUserId)
    throw new Error(`Account ${account} not configured`);

  const token = cfg.pageAccessToken;
  const userId = cfg.igUserId;

  const isVid = isVideoUrl(mediaUrl);

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

/* ---------- Scheduler (1×/min) ---------- */
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
      const errMsg = e?.response?.data?.error?.message || e.message || 'unknown';
      console.error('[FAIL]', j.id, errMsg);
      markFailed.run(errMsg, j.id);
    }
  }
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Uploads at', `${APP_BASE_URL}/uploads/...`);
});
