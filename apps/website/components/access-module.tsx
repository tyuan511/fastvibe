import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Icon, type IconName } from "./icons";
import { PhoneIllustration } from "./illustrations";
import type { LatestMobileRelease, LatestRelease } from "@/lib/github-release";

/** iOS is a TestFlight beta; Android is the APK from GitHub Releases. */
const TESTFLIGHT_URL = "https://testflight.apple.com/join/esBzVH3v";

function Action({ href, icon, children, external = true }: { href: string; icon: IconName; children: string; external?: boolean }) {
  return (
    <a className="action-button" href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      <Icon name={icon} size={14} /><span>{children}</span>
    </a>
  );
}

/** The real client on a laptop, one capture per theme (the hidden one is never fetched). */
function Laptop() {
  const locale = useLocale();
  const t = useTranslations("access.desktop");
  return (
    <div className="laptop" aria-hidden="true">
      {(["light", "dark"] as const).map((theme) => (
        <Image key={theme} className={`only-${theme}`} src={`/desktop/${locale}/workspace-${theme}.jpg`} alt={t("title")} width={1600} height={1000} sizes="(max-width: 640px) 100vw, 640px" />
      ))}
    </div>
  );
}

export function AccessModule({ release, mobileRelease }: { release: LatestRelease; mobileRelease: LatestMobileRelease }) {
  const t = useTranslations("access");
  const { downloads } = release;

  return (
    <section aria-labelledby="access-title" className="module access-module" id="access">
      <h2 id="access-title" className="module-heading">{t("heading")}</h2>
      <div className="access-grid">
        <article className="access-card">
          <div className="access-media" data-kind="desktop"><Laptop /></div>
          <h3>{t("desktop.title")}</h3>
          <p>{t("desktop.copy")}</p>
          <div className="access-actions">
            <Action href={downloads.macArm.url} icon="apple" external={false}>{t("desktop.mac")}</Action>
            <Action href={downloads.windows.url} icon="windows" external={false}>{t("desktop.win")}</Action>
            <Action href={downloads.linuxAppImage.url} icon="linux" external={false}>{t("desktop.linux")}</Action>
          </div>
        </article>
        <article className="access-card">
          <div className="access-media" data-kind="mobile"><PhoneIllustration /></div>
          <h3>{t("mobile.title")}</h3>
          <p>{t("mobile.copy")}</p>
          <div className="access-actions">
            <Action href={TESTFLIGHT_URL} icon="apple">{t("mobile.ios")}</Action>
            <Action href={mobileRelease.apkUrl} icon="android">{t("mobile.android")}</Action>
          </div>
        </article>
      </div>
    </section>
  );
}
