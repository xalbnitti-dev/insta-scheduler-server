import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import cron from "node-cron";
import axios from "axios";

/** ================== ENV & CONSTANTS ================== */
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:10000";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "CHANGE_ME";
const FB_APP_ID = process.env.FB_APP_ID || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const POLL_MAX_MS = Number(process.env.POLL_MAX_MS || 180000);
const GRAPH = "https://graph.facebook.com/v21.0";

/** ================== STORAGE ================== */
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.ensureDirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage });

/** ================== TYPES ================== */
type AccountConfig = {
  page_id?: string;
  ig_user_id: string;
  page_access_token?: string; // nëse s’përdor System User flow
};

type Job = {
  id: string;
  account: string; // ky duhet të përputhet me një key në IG_ACCOUNT_MAP
  caption: string;
  imageUrl: string;
  when: string; // ISO
  status: "pending" | "publishing" | "done" | "failed";
  attempts: number;
  lastError?: string;
  mediaId?: string;
};

const JOBS: Job[] = []; // In-memory demo (ruaje në DB në prod)

/** ================== HELPERS ================== */
function ok(res: Response, body: any) {
  res.setHeader("Content-Type", "application/json");
  return res.status(200).send(JSON.stringify(body));
}
function bad(res: Response, code: number, msg: string) {
  return res.status(code).json({ error: msg });
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = (req.headers["x-admin-key"] as string) || (req.query.key as string);
  if (!ADMIN_API_KEY) return bad(res, 500, "ADMIN_API_KEY not set");
  if (key !== ADMIN_API_KEY) return bad(res, 401, "Unauthorized");
  next();
}

function parseAccountMap(): Record<string, AccountConfig> {
  const raw = process.env.IG_ACCOUNT_MAP_JSON || process.env.IG_ACCOUNT_MAP || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Failed to parse IG_ACCOUNT_MAP/JSON");
    return {};
  }
}

let IG_ACCOUNTS: Record<string, AccountConfig> = parseAccountMap();

/** ========== IG GRAPH HELPERS (images) ========== */
async function createImageContainer(opts: {
  igUserId: string;
  imageUrl: string;
  caption?: string;
  token: string;
}) {
  const { data } = await axios.post(`${GRAPH}/${opts.igUserId}/media`, null, {
    params: { image_url: opts.imageUrl, caption: opts.caption, access_token: opts.token },
  });
  return data.id as string; // creation_id
}

async function waitUntilReady(creationId: string, token: string, timeoutMs = POLL_MAX_MS, intervalMs = POLL_INTERVAL_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await axios.get(`${GRAPH}/${creationId}`, {
      params: { fields: "status_code,id", access_token: token },
    });
    if (data.status_code === "FINISHED") return true;
    if (data.status_code === "ERROR") throw new Error("IG processing error for creation_id");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout waiting for IG media to be ready");
}

async function publishContainer(opts: { igUserId: string; creationId: string; token: string }) {
  const { data } = await axios.post(`${GRAPH}/${opts.igUserId}/media_publish`, null, {
    params: { creation_id: opts.creationId, access_token: opts.token },
  });
  return data as { id: string }; // media_id
}

/** ========== TOKEN TOOLS ========== */
async function debugToken(inputToken: string) {
  const { data } = await axios.get(`${GRAPH}/debug_token`, {
    params: { input_token: inputToken, access_token: `${FB_APP_ID}|${FB_APP_SECRET}` },
  });
  return data;
}
async function extendUserToken(userToken: string) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: FB_APP_ID,
      client_secret: FB_APP_SECRET,
      fb_exchange_token: userToken,
    },
  });
  return data as { access_token: string; token_type: string; expires_in: number };
}
async function listUserPages(userToken: string) {
  const { data } = await axios.get(`${GRAPH}/me/accounts`, {
    params: { fields: "id,name,access_token,instagram_business_account", access_token: userToken },
  });
  return (data.data || []) as Array<{
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string };
  }>;
}
async function getPageAccessToken(pageId: string, actorToken: string) {
  const { data } = await axios.get(`${GRAPH}/${pageId}`, {
    params: { fields: "access_token", access_token: actorToken },
  });
  return data.access_token as string;
}
async function getIGFromPage(pageId: string, pageToken: string) {
  const { data } = await axios.get(`${GRAPH}/${pageId}`, {
    params: { fields: "instagram_business_account", access_token: pageToken },
  });
  return (data.instagram_business_account?.id as string) || null;
}

/** ================== APP ================== */
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

/** Health */
app.get("/health", (_req, res) => ok(res, { ok: true }));

/** Upload multi (admin) */
app.post("/upload-multi", requireAdmin, upload.array("images", 100), (req, res) => {
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

/** Bulk schedule (admin) */
app.post("/posts/schedule-bulk", requireAdmin, (req, res) => {
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

/** Jobs (admin) */
app.get("/jobs", requireAdmin, (_req, res) => ok(res, { jobs: JOBS }));

/** Reload accounts (admin) */
app.post("/api/reload-accounts", requireAdmin, (_req, res) => {
  IG_ACCOUNTS = parseAccountMap();
  return ok(res, { ok: true, keys: Object.keys(IG_ACCOUNTS) });
});

/** TOKEN ROUTES (admin) */
app.post("/api/token/debug", requireAdmin, async (req, res) => {
  try {
    const { token } = req.body as { token: string };
    const out = await debugToken(token);
    return ok(res, out);
  } catch (e: any) {
    return bad(res, 400, e?.response?.data?.error?.message || e?.message || "debug error");
  }
});

app.post("/api/token/extend", requireAdmin, async (req, res) => {
  try {
    const { userToken } = req.body as { userToken: string };
    const out = await extendUserToken(userToken);
    return ok(res, out);
  } catch (e: any) {
    return bad(res, 400, e?.response?.data?.error?.message || e?.message || "extend error");
  }
});

app.post("/api/token/pages", requireAdmin, async (req, res) => {
  try {
    const { userToken } = req.body as { userToken: string };
    const pages = await listUserPages(userToken);
    return ok(res, { pages });
  } catch (e: any) {
    return bad(res, 400, e?.response?.data?.error?.message || e?.message || "pages error");
  }
});

app.post("/api/token/page-access", requireAdmin, async (req, res) => {
  try {
    const { pageId, actorToken } = req.body as { pageId: string; actorToken: string };
    const pageToken = await getPageAccessToken(pageId, actorToken);
    return ok(res, { pageToken });
  } catch (e: any) {
    return bad(res, 400, e?.response?.data?.error?.message || e?.message || "page-access error");
  }
});

app.post("/api/token/ig-from-page", requireAdmin, async (req, res) => {
  try {
    const { pageId, pageToken } = req.body as { pageId: string; pageToken: string };
    const igUserId = await getIGFromPage(pageId, pageToken);
    return ok(res, { igUserId });
  } catch (e: any) {
    return bad(res, 400, e?.response?.data?.error?.message || e?.message || "ig-from-page error");
  }
});

/** ================== CRON: çdo 1 minutë ================== */
cron.schedule("* * * * *", async () => {
  const now = new Date();

  for (const job of JOBS) {
    if (job.status !== "pending") continue;
    const when = new Date(job.when);
    if (when > now) continue;

    const cfg = IG_ACCOUNTS[job.account];
    if (!cfg || !cfg.ig_user_id || !cfg.page_access_token) {
      job.status = "failed";
      job.lastError = "Account config missing (ig_user_id/page_access_token)";
      continue;
    }

    try {
      job.status = "publishing";

      const creationId = await createImageContainer({
        igUserId: cfg.ig_user_id,
        imageUrl: job.imageUrl,
        caption: job.caption,
        token: cfg.page_access_token,
      });

      await waitUntilReady(creationId, cfg.page_access_token, POLL_MAX_MS, POLL_INTERVAL_MS);

      const published = await publishContainer({
        igUserId: cfg.ig_user_id,
        creationId,
        token: cfg.page_access_token,
      });

      job.status = "done";
      job.mediaId = published.id;
      job.lastError = undefined;
      console.log(`[PUBLISH OK] ${job.account} → media_id=${published.id}`);
    } catch (err: any) {
      const code = err?.response?.data?.error?.code;
      const sub = err?.response?.data?.error?.error_subcode;
      const msg = err?.response?.data?.error?.message || err?.message || String(err);

      if (code === 190) {
        job.lastError = `TOKEN_EXPIRED (${sub}) – përditëso page_access_token te IG_ACCOUNT_MAP dhe thirr /api/reload-accounts`;
      } else {
        job.lastError = msg;
      }
      job.status = "failed";
      job.attempts += 1;
      console.error(`[PUBLISH FAIL] ${job.account} → ${job.lastError}`);
    }
  }
});

/** ================== START ================== */
app.listen(PORT, () => {
  console.log(`Server listening on ${APP_BASE_URL} (PORT ${PORT})`);
});
