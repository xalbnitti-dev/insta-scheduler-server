// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

// -------- CONFIG --------
const PORT = process.env.PORT || 10000;
const TMP_STORE = "/tmp/queue.json";

// Mapo llogaritë sipas env që i ke vendosur te Render
const ACCOUNTS: Record<
  string,
  { igId: string; pageToken: string }
> = {
  aurora: {
    igId: process.env.IG_AURORA_ID || "",
    pageToken: process.env.PAGE_AURORA_ACCESS_TOKEN || "",
  },
  novara: {
    igId: process.env.IG_NOVARA_ID || "",
    pageToken: process.env.PAGE_NOVARA_ACCESS_TOKEN || "",
  },
  selena: {
    igId: process.env.IG_SELENA_ID || "",
    pageToken: process.env.PAGE_SELENA_ACCESS_TOKEN || "",
  },
  cynara: {
    igId: process.env.IG_CYNARA_ID || "",
    pageToken: process.env.PAGE_CYNARA_ACCESS_TOKEN || "",
  },
};

// -------- TYPES & QUEUE --------
type Job = {
  id: string;
  account: keyof typeof ACCOUNTS;
  caption: string;
  imageUrl: string;
  whenISO: string; // ISO string në UTC
  status: "pending" | "done" | "failed";
  lastError?: string;
};

let queue: Job[] = [];

// load nga /tmp (nëse ekziston)
(function loadQueue() {
  try {
    if (fs.existsSync(TMP_STORE)) {
      queue = JSON.parse(fs.readFileSync(TMP_STORE, "utf8"));
      console.log(`[queue] loaded ${queue.length} items from /tmp`);
    }
  } catch (e) {
    console.warn("[queue] load failed:", e);
  }
})();

function saveQueue() {
  try {
    fs.writeFileSync(TMP_STORE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.warn("[queue] save failed:", e);
  }
}

// -------- IG PUBLISH HELPERS --------
async function publishToInstagram(
  igBusinessId: string,
  pageAccessToken: string,
  imageUrl: string,
  caption: string
) {
  // 1) Krijo media container
  const createRes = await axios.post(
    `https://graph.facebook.com/v19.0/${igBusinessId}/media`,
    {
      image_url: imageUrl,
      caption,
      is_carousel_item: false,
    },
    { params: { access_token: pageAccessToken } }
  );

  const containerId = createRes.data.id;

  // 2) Publiko
  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${igBusinessId}/media_publish`,
    { creation_id: containerId },
    { params: { access_token: pageAccessToken } }
  );

  return publishRes.data;
}

// -------- PROCESSOR --------
async function processDueJobs() {
  const now = Date.now();
  let processed = 0;
  for (const job of queue) {
    if (job.status !== "pending") continue;
    const when = Date.parse(job.whenISO);
    if (isNaN(when) || when > now) continue;

    const accountCfg = ACCOUNTS[job.account];
    if (!accountCfg?.igId || !accountCfg?.pageToken) {
      job.status = "failed";
      job.lastError = "Missing IG_ID or PAGE_TOKEN for account";
      continue;
    }

    try {
      console.log(`[job ${job.id}] publishing -> ${job.account}`);
      await publishToInstagram(
        accountCfg.igId,
        accountCfg.pageToken,
        job.imageUrl,
        job.caption || ""
      );
      job.status = "done";
      processed++;
      console.log(`[job ${job.id}] ✅ published`);
    } catch (err: any) {
      job.status = "failed";
      job.lastError =
        err?.response?.data ? JSON.stringify(err.response.data) : String(err);
      console.error(`[job ${job.id}] ❌`, job.lastError);
    }
  }
  saveQueue();
  return processed;
}

// -------- ROUTES --------
app.get("/health", (_req, res) => res.json({ ok: true }));

// planifikim nga frontend
app.post("/posts/schedule", (req: Request, res: Response) => {
  const { account, caption, imageUrl, when } = req.body || {};

  if (!account || !imageUrl || !when) {
    return res.status(400).json({ error: "Missing account/imageUrl/when" });
  }
  if (!ACCOUNTS[account]) {
    return res.status(400).json({ error: "Unknown account" });
  }

  // datetime-local vjen si kohë lokale -> ruaj si ISO (UTC)
  const whenISO = new Date(when).toISOString();

  const job: Job = {
    id: Math.random().toString(36).slice(2),
    account,
    caption: caption || "",
    imageUrl,
    whenISO,
    status: "pending",
  };
  queue.push(job);
  saveQueue();

  console.log(
    `[schedule] ${job.id} -> ${account} at ${whenISO} (from ${when})`
  );
  return res.status(201).json({ ok: true, id: job.id, whenISO });
});

// debug: shih pending
app.get("/posts/pending", (_req, res) => {
  res.json(queue);
});

// test: publiko tani një id
app.post("/posts/publish-now", async (req, res) => {
  const { id } = req.body || {};
  const job = queue.find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: "job not found" });

  job.whenISO = new Date().toISOString();
  const n = await processDueJobs();
  res.json({ ok: true, processed: n });
});

// endpoint për Cron Job-in
app.get("/cron/run", async (_req, res) => {
  const n = await processDueJobs();
  res.json({ ok: true, processed: n, queue: queue.length });
});

// -------- START --------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log("==> Your service is live 🚀");
});
