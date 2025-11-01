import axios from "axios";

const API = "https://graph.facebook.com/v21.0";

export async function createImageContainer(opts: {
  igUserId: string; imageUrl: string; caption?: string; token: string;
}) {
  const { igUserId, imageUrl, caption, token } = opts;
  const { data } = await axios.post(`${API}/${igUserId}/media`, null, {
    params: { image_url: imageUrl, caption, access_token: token }
  });
  return data.id as string; // creation_id
}

export async function waitUntilReady(creationId: string, token: string, timeoutMs=180000, intervalMs=3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await axios.get(`${API}/${creationId}`, {
      params: { fields: "status_code,id", access_token: token }
    });
    if (data.status_code === "FINISHED") return true;
    if (data.status_code === "ERROR") throw new Error("IG processing error");
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout waiting IG media");
}

export async function publishContainer(opts: { igUserId: string; creationId: string; token: string; }) {
  const { igUserId, creationId, token } = opts;
  const { data } = await axios.post(`${API}/${igUserId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: token }
  });
  return data as { id: string };
}
