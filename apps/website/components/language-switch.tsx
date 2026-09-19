"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function LanguageSwitch() {
  const t = useTranslations();
  const current = useLocale();
  const pathname = usePathname();
  return (
    <nav className="language-switch" aria-label={t("languageLabel")}>
      {(["zh", "en"] as const).map((locale) => (
        <Link
          key={locale}
          href={pathname}
          locale={locale}
          aria-current={current === locale ? "page" : undefined}
          scroll={false}
        >
          {locale === "zh" ? "中文" : "EN"}
        </Link>
      ))}
    </nav>
  );
}
