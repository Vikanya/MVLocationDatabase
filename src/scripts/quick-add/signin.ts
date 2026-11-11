// Signing in to GitHub on the quick-add pages. Pure (no DOM), tested with `npm test`.
// Only a token GitHub refuses (401) counts as "not signed in": then the next saved token is tried. Anything else
// (a timeout, a 502, a dropped connection, a rate limit) is retried, then offered as RETRY — it used to show the
// sign-in box, which read as "quick add doesn't see that I'm signed in".

/** GitHub refused the token itself (expired / revoked), as opposed to a hiccup worth retrying. */
export const isAuthError = (e: unknown) => (e as { status?: number })?.status === 401;

/** Waits before the automatic retries (ms). */
export const RETRIES = [1500, 4000];

export type SignIn<T> = { ok: true; token: string; value: T } | { ok: false; reason: 'none' | 'invalid' };

export interface SignInUi {
  /** A retry is coming: say what went wrong. */
  trying(message: string, attempt: number): void;
  wait(ms: number): Promise<void>;
  /** Retries used up: show the error and resolve when the user presses RETRY. */
  stuck(message: string): Promise<void>;
}

/**
 * Load with the first token that works. `load` reads everything the page needs with that token; `refused` is
 * told about each token GitHub refused (so a stale copy can be forgotten).
 */
export async function signIn<T>(tokens: string[], load: (token: string) => Promise<T>, ui: SignInUi, refused: (token: string) => void = () => {}): Promise<SignIn<T>> {
  if (!tokens.length) return { ok: false, reason: 'none' };
  let i = 0;
  let attempt = 0;
  for (;;) {
    try {
      return { ok: true, token: tokens[i], value: await load(tokens[i]) };
    } catch (e) {
      if (isAuthError(e)) {
        refused(tokens[i]);
        if (++i >= tokens.length) return { ok: false, reason: 'invalid' };
        attempt = 0;
        continue;
      }
      const message = (e as Error)?.message || String(e);
      if (attempt < RETRIES.length) {
        ui.trying(message, attempt + 1);
        await ui.wait(RETRIES[attempt++]);
        continue;
      }
      await ui.stuck(message);
      attempt = 0;
    }
  }
}
