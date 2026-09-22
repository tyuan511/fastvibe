import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { SitePage } from "@/components/site-page";
import { getLatestRelease } from "@/lib/github-release";
import { routing } from "@/i18n/routing";

export const revalidate = 600;

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const release = await getLatestRelease();
  return <SitePage release={release} />;
}
