import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { DownloadAsset, LatestRelease } from "@/lib/github-release";
import { Icon } from "./icons";

export function PlatformIcon({ platform }: { platform: "mac" | "windows" | "linux" }) {
  // Monochrome platform glyphs, never font characters whose rendering varies by OS.
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {platform === "mac" && <path d="M17.1 12.8c0-2 1.6-3 1.7-3.1-1-1.5-2.5-1.7-3.1-1.7-1.3-.1-2.5.8-3.2.8-.6 0-1.7-.8-2.8-.8C8.2 8 6.8 9 6 10.3c-1.6 2.7-.4 6.8 1.2 9 .7 1.1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.8-.7s1.7.7 2.9.7c1.2 0 1.9-1 2.6-2.1.9-1.2 1.2-2.4 1.2-2.5-.1 0-2.3-.9-2.3-4ZM15.1 6.5c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.6-1.2 1.8-1.1 2.8 1 .1 2.1-.5 2.8-1.2Z" />}
      {platform === "windows" && <path d="m2 4 9-1.2v8.3H2V4Zm10-1.4L22 1v10.1H12V2.6ZM2 12.2h9v8.4L2 19.3v-7.1Zm10 0h10V23l-10-1.6v-9.2Z" />}
      {platform === "linux" && <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10V7a5 5 0 0 1 10 0v3l3 7-3 2H7l-3-2 3-7Z" /><path d="m9 10 3 2 3-2M5 22l2-3 3 3H5Zm9 0 3-3 2 3h-5Z" /><circle cx="10" cy="7" r=".6" /><circle cx="14" cy="7" r=".6" /><path d="M9 14v3m6-3v3" /></g>}
    </svg>
  );
}

function DownloadLink({ asset, children }: { asset: DownloadAsset; children: ReactNode }) {
  const t = useTranslations("download");
  return (
    <a className="download-link" href={asset.url}>
      <span>{children}{!asset.available && <small>{t("unavailable")}</small>}</span>
      <Icon name={asset.available ? "download" : "external"} size={16} />
    </a>
  );
}

export function DownloadCards({ release }: { release: LatestRelease }) {
  const t = useTranslations("download");
  return (
    <div className="download-grid">
      <article className="download-card">
        <div className="download-card-top"><PlatformIcon platform="mac" /><h3>{t("macTitle")}</h3></div>
        <p className="download-card-copy">{t("macCopy")}</p>
        <div className="download-actions">
          <DownloadLink asset={release.downloads.macArm}>{t("appleSilicon")}</DownloadLink>
          <DownloadLink asset={release.downloads.macIntel}>{t("intel")}</DownloadLink>
        </div>
      </article>
      <article className="download-card">
        <div className="download-card-top"><PlatformIcon platform="windows" /><h3>{t("windowsTitle")}</h3></div>
        <p className="download-card-copy">{t("windowsCopy")}</p>
        <div className="download-actions">
          <DownloadLink asset={release.downloads.windows}>{t("downloadExe")}</DownloadLink>
        </div>
      </article>
      <article className="download-card">
        <div className="download-card-top"><PlatformIcon platform="linux" /><h3>{t("linuxTitle")}</h3></div>
        <p className="download-card-copy">{t("linuxCopy")}</p>
        <div className="download-actions">
          <DownloadLink asset={release.downloads.linuxAppImage}>{t("appImage")}</DownloadLink>
          <DownloadLink asset={release.downloads.linuxDeb}>{t("deb")}</DownloadLink>
        </div>
      </article>
    </div>
  );
}
