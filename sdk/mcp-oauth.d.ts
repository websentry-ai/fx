export interface BrowserOAuthProviderOptions {
  serverUrl: string;
  storagePrefix: string;
  redirectUrl: string;
  clientName: string;
}

export class BrowserOAuthProvider {
  constructor(options: BrowserOAuthProviderOptions);
}

export function signOut(storagePrefix: string, serverUrl: string): void;
export function openSignInWindow(): Window | null;
export function signIn(options: {
  serverUrl: string;
  popup: Window;
  provider: BrowserOAuthProvider;
  channel: string;
}): Promise<void>;
