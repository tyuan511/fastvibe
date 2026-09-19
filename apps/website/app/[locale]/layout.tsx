import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "../globals.css";

type Props = { params: Promise<{ locale: string }> };

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#101016" },
  ],
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return {
    title: t("title"),
    description: t("description"),
    metadataBase: new URL("https://fastvibe.dev"),
    icons: { icon: "/brand/f-mark.png" },
    alternates: {
      canonical: `/${locale}`,
      languages: { zh: "/zh", en: "/en", "x-default": "/" },
    },
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: `/${locale}`,
      locale: locale === "zh" ? "zh_CN" : "en_US",
      type: "website",
      images: [{ url: `/screenshots/${locale}/workspace.webp`, width: 2880, height: 1800, alt: t("features.workspace.alt") }],
    },
  };
}

export default async function LocaleLayout({ children, params }: Props & { children: ReactNode }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
