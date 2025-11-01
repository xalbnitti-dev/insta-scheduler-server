import fs from "fs-extra";

export function parseAccountMap(): Record<string, {
  page_id?: string;
  ig_user_id: string;
  page_access_token?: string;
}> {
  const raw = process.env.IG_ACCOUNT_MAP_JSON || process.env.IG_ACCOUNT_MAP;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function ensureFile(path: string) {
  await fs.ensureFile(path);
}
