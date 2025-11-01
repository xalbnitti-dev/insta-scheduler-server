declare namespace NodeJS {
  interface ProcessEnv {
    APP_BASE_URL: string;
    ADMIN_API_KEY: string;
    IG_ACCOUNT_MAP?: string;
    IG_ACCOUNT_MAP_JSON?: string;
    FB_APP_ID: string;
    FB_APP_SECRET: string;
    SYSTEM_USER_TOKEN?: string;
    POLL_INTERVAL_MS?: string;
    POLL_MAX_MS?: string;
    PORT?: string;
  }
}
