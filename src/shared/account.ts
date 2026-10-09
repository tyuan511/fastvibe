/**
 * The FastVibe account this desktop is signed in to (app.fastvibe.dev).
 *
 * Shared by Main, which owns the sign-in and the credential, and the renderer, which only
 * ever sees this: who is signed in, never the token that proves it.
 */
export type AccountUser = {
  id: string;
  /** The GitHub username the account was created from. */
  login: string;
  avatarUrl: string | null;
  email: string | null;
  role: "user" | "admin";
};

export type AccountStatus = "signed-out" | "signing-in" | "signed-in";

export type AccountState = {
  status: AccountStatus;
  /** Present while `signed-in`; kept when a refresh could not reach the server. */
  user?: AccountUser;
  /** Why the last sign-in did not complete, for a person to read. Cleared by the next attempt. */
  error?: string;
  /** The site the account lives on, for the 控制台 link. */
  origin: string;
};

/** Where the desktop signs in; overridden for local development. */
export const DEFAULT_ACCOUNT_ORIGIN = "https://app.fastvibe.dev";
