"use client";

import { useTranslations } from "next-intl";
import { Icon, type IconName } from "../icons";

const PREVIEWS = [
  { icon: "sparkles", key: "models" },
  { icon: "globe", key: "usage" },
  { icon: "shield", key: "keys" },
] as const satisfies readonly { icon: IconName; key: string }[];

/** A placeholder. The nav item exists so the section has a home before there is anything in it. */
export function MorePanel() {
  const t = useTranslations("console.more");
  return (
    <section className="acct-soon" aria-labelledby="more-title">
      <div className="acct-soon-mark" aria-hidden="true"><Icon name="sparkles" size={26} /></div>
      <h1 id="more-title" className="acct-title">{t("title")}</h1>
      <p className="acct-sub">{t("lead")}</p>
      <span className="acct-badge" data-role="current">{t("badge")}</span>
      <ul className="acct-soon-grid">
        {PREVIEWS.map(({ icon, key }) => (
          <li key={key}>
            <span className="acct-soon-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
            <span>
              <strong>{t(`previews.${key}.title`)}</strong>
              <em>{t(`previews.${key}.lead`)}</em>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
