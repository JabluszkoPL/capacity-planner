/**
 * The seam between this pure package and the network.
 *
 * Jira Cloud's REST API does not answer browser cross-origin requests, so the
 * one thing that genuinely differs between hosts is *how* a request can be
 * made at all: the Mac app goes through Electron's main process, a browser
 * goes through the sync server, and a browser without one cannot refresh.
 * Everything else — which URL, which JQL, how to read the answer — is
 * identical everywhere, so it lives here and the call itself is injected.
 *
 * `canWrite` is part of the interface rather than something the caller infers,
 * because the proxy transports deliberately refuse writes unless the deployer
 * opted in (`PLANNER_JIRA_WRITES=1`). The UI needs to disable the write-back
 * button before a request is attempted, not discover the refusal afterwards.
 *
 * The auth string is passed per request and never held by a transport: nothing
 * in this package stores credentials, and nothing logs them.
 */

/** One request, fully described so any host can replay it. */
export interface JiraRequest {
  /** Site origin, e.g. `https://acme.atlassian.net`. No trailing slash. */
  baseUrl: string;
  /** Absolute path, e.g. `/rest/api/3/search/jql`. */
  path: string;
  method: "GET" | "POST" | "PUT";
  /** `Authorization` header value — built by {@link basicAuth}, never stored. */
  auth: string;
  /** Sent as JSON for POST/PUT. */
  body?: unknown;
  /**
   * Beta programs to opt into, sent as `X-ExperimentalApi`. Only ever set on
   * the GraphQL gateway (some Teams fields are beta), and the relays forward
   * it only there, only for these word-like values.
   */
  experimental?: string[];
}

export interface JiraResponse {
  status: number;
  /** Parsed JSON, or `null` when the response had no body. */
  body: unknown;
  /**
   * Optional, lower-cased response headers. Only `retry-after` is read (see
   * refresh.ts); a transport that cannot expose headers simply omits this and
   * the retry falls back to a fixed delay.
   */
  headers?: Record<string, string>;
}

export interface JiraTransport {
  /** False when this host refuses PUT/POST-write requests. */
  readonly canWrite: boolean;
  request(req: JiraRequest): Promise<JiraResponse>;
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * UTF-8 bytes of a string, surrogate pairs folded back into one code point.
 *
 * Hand-rolled because the platform disagrees about which encoder exists:
 * `Buffer` is Node-only, `TextEncoder` is not guaranteed in every runtime this
 * package is bundled into, and `btoa` mangles anything above U+00FF. Twenty
 * lines here means the same code runs in a browser, in Node, and in Electron.
 */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** Standard (padded, `+/`) base64 of a string's UTF-8 bytes. */
export function base64(text: string): string {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b0 = bytes[i];
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += has2 ? B64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * `Authorization` value for Jira Cloud Basic auth: `base64(email:apiToken)`.
 *
 * Both halves are trimmed because an API token is nearly always pasted, and a
 * trailing newline from the clipboard otherwise produces a 401 that looks like
 * a wrong token.
 */
export function basicAuth(email: string, token: string): string {
  return `Basic ${base64(`${email.trim()}:${token.trim()}`)}`;
}
