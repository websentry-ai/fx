import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface BrowserMcpStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserOAuthProviderOptions {
  serverUrl: string;
  storage?: BrowserMcpStorage;
  storagePrefix: string;
  redirectUrl: string;
  clientName?: string;
}

export class BrowserOAuthProvider {
  constructor(options: BrowserOAuthProviderOptions);
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly clientName: string;
  authorizationUrl: URL | null;
  attemptState: string | null;
  readonly clientMetadata: OAuthClientMetadata;
  state(): string;
  clientInformation(): OAuthClientInformationMixed | undefined;
  saveClientInformation(client: OAuthClientInformationMixed): void;
  tokens(): OAuthTokens | undefined;
  saveTokens(tokens: OAuthTokens): void;
  redirectToAuthorization(authorizationUrl: URL): void;
  saveCodeVerifier(verifier: string): void;
  codeVerifier(): string;
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void;
}

export function signOut(storagePrefix: string, serverUrl: string, storage?: BrowserMcpStorage): void;
export function openSignInWindow(): Window | null;
export function signIn(options: {
  serverUrl: string;
  popup: Window;
  provider: BrowserOAuthProvider;
  channel: string;
}): Promise<void>;
