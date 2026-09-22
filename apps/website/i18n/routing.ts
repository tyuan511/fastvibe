import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "en",
  localePrefix: "always",
  localeCookie: { name: "FASTVIBE_LOCALE", maxAge: 60 * 60 * 24 * 365 },
});
