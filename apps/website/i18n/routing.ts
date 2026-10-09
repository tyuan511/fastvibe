import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "en",
  // Language lives in the cookie, not the path. Visiting /zh or /en still works:
  // the middleware writes the cookie and redirects back to the same path.
  localePrefix: "never",
  localeCookie: { name: "FASTVIBE_LOCALE", maxAge: 60 * 60 * 24 * 365 },
});
