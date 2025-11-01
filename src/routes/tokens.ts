import { Router } from "express";
import { debugToken, extendUserToken, listUserPages, getPageAccessToken, getIGFromPage } from "../models/tokens";

const r = Router();

// all routes protected via x-admin-key (vendos middleware-in në server.ts)

r.post("/debug", async (req, res) => {
  try {
    const { token } = req.body;
    const out = await debugToken(token);
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.response?.data || e.message }); }
});

r.post("/extend", async (req, res) => {
  try {
    const { userToken } = req.body;
    const out = await extendUserToken(userToken);
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.response?.data || e.message }); }
});

r.post("/pages", async (req, res) => {
  try {
    const { userToken } = req.body;
    const pages = await listUserPages(userToken);
    res.json({ pages });
  } catch (e: any) { res.status(400).json({ error: e.response?.data || e.message }); }
});

r.post("/page-access", async (req, res) => {
  try {
    const { pageId, actorToken } = req.body;
    const pageToken = await getPageAccessToken(pageId, actorToken);
    res.json({ pageToken });
  } catch (e: any) { res.status(400).json({ error: e.response?.data || e.message }); }
});

r.post("/ig-from-page", async (req, res) => {
  try {
    const { pageId, pageToken } = req.body;
    const igUserId = await getIGFromPage(pageId, pageToken);
    res.json({ igUserId });
  } catch (e: any) { res.status(400).json({ error: e.response?.data || e.message }); }
});

export default r;
