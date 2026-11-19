/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OAuth 2.0 Web client ID for the Google Sheets push. Optional; when
   *  unset, the "Send to Google Sheets" action explains how to configure it. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

/** Planner's version, from the workspace root package.json at build time. */
declare const __PLANNER_VERSION__: string;
/** The root package.json `repository` field — where releases are published. */
declare const __PLANNER_REPOSITORY__: unknown;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Minimal typing for the Google Identity Services token client, loaded at
 * runtime from https://accounts.google.com/gsi/client. Only the surface the
 * app uses is declared.
 */
interface GsiTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GsiTokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
  callback: (resp: GsiTokenResponse) => void;
}

interface Window {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (resp: GsiTokenResponse) => void;
          error_callback?: (err: { type?: string; message?: string }) => void;
        }) => GsiTokenClient;
      };
    };
  };
}
