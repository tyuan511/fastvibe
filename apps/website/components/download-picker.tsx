"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { DownloadAsset, LatestRelease } from "@/lib/github-release";
import { Icon, type IconName } from "./icons";

type Platform = "mac" | "windows" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "mac";
}

const platformIcon: Record<Platform, IconName> = { mac: "apple", windows: "windows", linux: "linux" };
const platformName: Record<Platform, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

/**
 * The hero's split download button. The links are real anchors inside a native
 * `<details>`, so every installer is reachable with JavaScript off; the script only
 * promotes the visitor's own platform to the primary button and closes the menu on
 * an outside click.
 */
export function DownloadPicker({ release }: { release: LatestRelease }) {
  const t = useTranslations();
  const [platform, setPlatform] = useState<Platform>("mac");
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setPlatform(detectPlatform());
    const close = (event: Event) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current) menu.current.open = false; };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const primary: Record<Platform, DownloadAsset> = {
    mac: release.downloads.macArm,
    windows: release.downloads.windows,
    linux: release.downloads.linuxAppImage,
  };
  const groups: { platform: Platform; items: { label: string; asset: DownloadAsset }[] }[] = [
    { platform: "mac", items: [{ label: t("download.appleSilicon"), asset: release.downloads.macArm }, { label: t("download.intel"), asset: release.downloads.macIntel }] },
    { platform: "windows", items: [{ label: t("download.downloadExe"), asset: release.downloads.windows }] },
    { platform: "linux", items: [{ label: t("download.appImage"), asset: release.downloads.linuxAppImage }, { label: t("download.deb"), asset: release.downloads.linuxDeb }] },
  ];

  return (
    <div className="download-picker">
      <a className="download-primary" href={primary[platform].url}>
        <Icon name={platformIcon[platform]} size={16} />
        <span>{t("hero.download")}</span>
      </a>
      <details className="download-more" ref={menu}>
        <summary aria-label={t("download.menu")}><Icon name="chevron-down" size={15} /></summary>
        <div className="download-menu">
          {groups.map(({ platform: id, items }) => (
            <div className="download-menu-group" key={id}>
              <p><Icon name={platformIcon[id]} size={14} />{platformName[id]}</p>
              {items.map(({ label, asset }) => (
                <a key={label} href={asset.url}>
                  <span>{label}{!asset.available && <small>{t("download.unavailable")}</small>}</span>
                  <Icon name={asset.available ? "download" : "external"} size={14} />
                </a>
              ))}
            </div>
          ))}
          <a className="download-menu-release" href={release.url} target="_blank" rel="noreferrer">
            <span>{release.isFallback ? t("download.fallback") : <>{release.version} · {t("download.releaseNotes")}</>}</span>
            <Icon name="arrow-up-right" size={13} />
          </a>
        </div>
      </details>
    </div>
  );
}
