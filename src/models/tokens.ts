import axios from "axios";
const API = "https://graph.facebook.com/v21.0";
const { FB_APP_ID, FB_APP_SECRET } = process.env;

export async function debugToken(inputToken: string) {
  const { data } = await axios.get(`${API}/debug_token`, {
    params: { input_token: inputToken, access_token: `${FB_APP_ID}|${FB_APP_SECRET}` }
  });
  return data;
}

export async function extendUserToken(userToken: string) {
  const { data } = await axios.get(`${API}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: FB_APP_ID,
      client_secret: FB_APP_SECRET,
      fb_exchange_token: userToken
    }
  });
  return data as { access_token: string; token_type: string; expires_in: number };
}

export async function listUserPages(userToken: string) {
  const { data } = await axios.get(`${API}/me/accounts`, {
    params: { fields: "id,name,access_token,instagram_business_account", access_token: userToken }
  });
  return data.data as Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string } }>;
}

export async function getPageAccessToken(pageId: string, actorToken: string) {
  const { data } = await axios.get(`${API}/${pageId}`, {
    params: { fields: "access_token", access_token: actorToken }
  });
  return data.access_token as string;
}

export async function getIGFromPage(pageId: string, pageToken: string) {
  const { data } = await axios.get(`${API}/${pageId}`, {
    params: { fields: "instagram_business_account", access_token: pageToken }
  });
  return (data.instagram_business_account?.id as string) || null;
}
