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
  clientName: string;
}

export class BrowserOAuthProvider {
  constructor(options: BrowserOAuthProviderOptions);
}

export function signOut(storagePrefix: string, serverUrl: string, storage?: BrowserMcpStorage): void;
export function openSignInWindow(): Window | null;
export function signIn(options: {
  serverUrl: string;
  popup: Window;
  provider: BrowserOAuthProvider;
  channel: string;
}): Promise<void>;
