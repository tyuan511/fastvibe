"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { LatestRelease } from "@/lib/github-release";
import { Icon } from "./icons";

const platforms = ["mac", "windows", "linux"] as const;

/** A compact download strip under the real workspace, not a simulated terminal. */
export function DownloadPicker({ release }: { release: LatestRelease }) {
  const [platform, setPlatform] = useState<(typeof platforms)[number]>("mac");
  const t = useTranslations();
  const options = {
    mac: [{ label: t("download.appleSilicon"), asset: release.downloads.macArm }, { label: t("download.intel"), asset: release.downloads.macIntel }],
    windows: [{ label: t("download.downloadExe"), asset: release.downloads.windows }],
    linux: [{ label: t("download.appImage"), asset: release.downloads.linuxAppImage }, { label: t("download.deb"), asset: release.downloads.linuxDeb }],
  };

  return (
    <div className="download-picker">
      <div className="platform-tabs" role="group" aria-label={t("hero.platformLabel")}>
        {platforms.map((value) => (
          <button key={value} type="button" aria-pressed={value === platform} onClick={() => setPlatform(value)}>
            {value === "mac" ? "macOS" : value === "windows" ? "Windows" : "Linux"}
          </button>
        ))}
      </div>
      <div className="installer-actions">
        {options[platform].map(({ label, asset }) => (
          <a key={label} href={asset.url} className="installer-link">
            <span>{label}{!asset.available && <small>{t("download.unavailable")}</small>}</span>
            <Icon name={asset.available ? "download" : "external"} size={14} />
          </a>
        ))}
      </div>
    </div>
  );
}
