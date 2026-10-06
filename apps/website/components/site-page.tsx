import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { AccessModule } from "./access-module";
import { BestPracticesModule } from "./best-practices-module";
import { DownloadPicker } from "./download-picker";
import { AppPreview } from "./app-preview";
import { HeroBackdrop } from "./hero-backdrop";
import { Icon } from "./icons";
import { ScrollReveal } from "./scroll-reveal";
import { SiteHeader } from "./site-header";
import { TaskModule } from "./task-module";
import type { LatestMobileRelease, LatestRelease } from "@/lib/github-release";

const GITHUB_URL = "https://github.com/tyuan511/fastvibe";

export function SitePage({ release, mobileRelease }: { release: LatestRelease; mobileRelease: LatestMobileRelease }) {
  const t = useTranslations();
  const locale = useLocale();
  const guide = `${GITHUB_URL}/blob/main/${locale === "zh" ? "README.zh-CN.md" : "README.md"}`;

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">{t("skip")}</a>
      <SiteHeader />
      <ScrollReveal />

      <main id="main-content">
        <section className="hero" id="top">
          <HeroBackdrop />
          <div className="hero-inner">
            <h1>{t("hero.title").split("\n").map((line) => <span className="title-line" key={line}>{line}</span>)}</h1>
            <p className="hero-lead">{t("hero.lead")}</p>
            <DownloadPicker release={release} />
          </div>
          <div className="hero-preview"><AppPreview /></div>
        </section>

        <TaskModule />
        <BestPracticesModule />
        <AccessModule release={release} mobileRelease={mobileRelease} />
      </main>

      <footer className="site-footer">
        <div className="footer-wrap">
          <div className="footer-inner">
            <div className="footer-brand">
              <a className="brand" href="#top"><Image src="/brand/f-mark.png" alt="" width={24} height={24} /><span>FastVibe</span></a>
              <p>{t("footer.desc")}</p>
            </div>
            <div className="footer-columns">
              <section>
                <h2>{t("footer.colProduct")}</h2>
                <a href="#access">{t("footer.download")}</a>
                <a href={release.url} target="_blank" rel="noreferrer">{t("footer.changelog")}</a>
                <a href={`${GITHUB_URL}/releases`} target="_blank" rel="noreferrer">{t("footer.releases")}</a>
              </section>
              <section>
                <h2>{t("footer.colDocs")}</h2>
                <a href={guide} target="_blank" rel="noreferrer">{t("footer.quickstart")}</a>
                <a href="https://pi.dev" target="_blank" rel="noreferrer">{t("footer.builtOnPi")}</a>
              </section>
              <section>
                <h2>{t("footer.colCommunity")}</h2>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
                <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">{t("footer.contact")}</a>
              </section>
            </div>
          </div>
          <div className="footer-bottom">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub"><Icon name="github" size={18} /></a>
            <p>{t("footer.license")} · © {new Date().getFullYear()} FastVibe</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
