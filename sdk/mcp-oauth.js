// OAuth for remote MCP servers, the way MCP clients do it: register the page as
// a public client (dynamic client registration), send the user to the server's
// consent screen in a popup, and trade the code for tokens with PKCE. Tokens
// stay in this browser, per server URL, and the SDK refreshes them.
//
// The host supplies the redirect page. It must be a page on this origin that
// posts the query back on `channel`; sdk/mcp-callback.html is one.

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Reads and writes one server's OAuth state in localStorage. */
function store(prefix, serverUrl) {
  const key = `${prefix}.mcp-oauth.${serverUrl}`;
  return {
    read() {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        return {};
      }
    },
    write(change) {
      try {
        localStorage.setItem(key, JSON.stringify({ ...this.read(), ...change }));
      } catch {}
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };
}

/** An MCP OAuth client for one server, as the SDK's transports expect. */
export class BrowserOAuthProvider {
  /** Where the SDK asked to send the user; set when the server needs a sign-in. */
  authorizationUrl = null;
  // This attempt's own state and verifier. Two sign-ins to one server can run at
  // once, and each must exchange its code with the verifier it was issued with.
  attemptState = null;
  #attemptVerifier = null;
  #store;

  constructor({ serverUrl, storagePrefix, redirectUrl, clientName }) {
    this.serverUrl = serverUrl;
    this.redirectUrl = redirectUrl;
    this.clientName = clientName ?? "fx";
    this.#store = store(storagePrefix, serverUrl);
  }

  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    this.attemptState = crypto.randomUUID();
    return this.attemptState;
  }

  clientInformation() {
    return this.#store.read().client;
  }

  saveClientInformation(client) {
    this.#store.write({ client });
  }

  tokens() {
    return this.#store.read().tokens;
  }

  saveTokens(tokens) {
    this.#store.write({ tokens });
  }

  // A popup needs the user's click, so this only records where to go.
  redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(verifier) {
    this.#attemptVerifier = verifier;
  }

  codeVerifier() {
    if (!this.#attemptVerifier) throw new Error("No sign-in is in progress for this server.");
    return this.#attemptVerifier;
  }

  invalidateCredentials(scope) {
    if (scope === "all") this.#store.clear();
    if (scope === "client") this.#store.write({ client: undefined });
    if (scope === "tokens") this.#store.write({ tokens: undefined });
    if (scope === "verifier") this.#attemptVerifier = null;
  }
}

/** Drops a server's tokens and its registration. */
export function signOut(storagePrefix, serverUrl) {
  store(storagePrefix, serverUrl).clear();
}

/**
 * Opens the sign-in window. Call it while the browser still counts the user's
 * click or keypress; it returns null when the browser blocks the window.
 */
export function openSignInWindow() {
  return window.open("", "fx-mcp-oauth", "popup,width=520,height=720");
}

/**
 * Signs the user in to a remote server in `popup`: points it at the server's
 * consent screen and waits for the redirect page to post the code back.
 */
export async function signIn({ serverUrl, popup, provider, channel }) {
  try {
    const first = await auth(provider, { serverUrl });
    if (first === "AUTHORIZED") {
      popup.close();
      return;
    }
    if (!provider.authorizationUrl) throw new Error("The server gave no sign-in page.");
    popup.location.href = provider.authorizationUrl.toString();
    const code = await waitForCode(provider.attemptState, channel);
    await auth(provider, { serverUrl, authorizationCode: code });
  } catch (error) {
    popup.close();
    throw error;
  }
}

// The popup is not watched for closing: a consent screen that sets
// Cross-Origin-Opener-Policy makes the popup read as closed while it is open.
function waitForCode(state, channelName) {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(channelName);
    const done = () => {
      clearTimeout(timeout);
      channel.close();
    };
    channel.onmessage = ({ data }) => {
      if (data?.state !== state) return;
      done();
      if (typeof data.code === "string") resolve(data.code);
      else reject(new Error(data.error_description || data.error || "The server did not grant access."));
    };
    const timeout = setTimeout(() => {
      done();
      reject(new Error("The sign-in did not finish. Try again."));
    }, SIGN_IN_TIMEOUT_MS);
  });
}
