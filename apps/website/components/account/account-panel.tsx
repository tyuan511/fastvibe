"use client";

import { useLocale, useTranslations } from "next-intl";
import { Icon } from "../icons";
import { useMe } from "./console-shell";

export function AccountPanel() {
  const t = useTranslations("console.account");
  const locale = useLocale();
  const me = useMe();
  const since = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(me.created_at));

  return (
    <section aria-labelledby="account-title">
      <h1 id="account-title" className="acct-title">{t("title")}</h1>
      <p className="acct-sub">{t("lead")}</p>

      <div className="acct-panel">
        <div className="acct-profile">
          {me.avatar_url && (
            // eslint-disable-next-line @next/next/no-img-element -- GitHub's CDN avatar, shown once
            <img src={me.avatar_url} alt="" width={64} height={64} referrerPolicy="no-referrer" />
          )}
          <div>
            <p className="acct-name">{me.login}</p>
            <a className="acct-link" href={`https://github.com/${encodeURIComponent(me.login)}`} target="_blank" rel="noreferrer">
              <Icon name="github" size={14} />{t("openGithub")}
            </a>
          </div>
        </div>

        <dl className="acct-facts">
          <div><dt>{t("username")}</dt><dd>{me.login}</dd></div>
          <div>
            <dt>{t("email")}</dt>
            <dd>{me.email ?? <span className="acct-muted">{t("noEmail")}</span>}</dd>
          </div>
          <div>
            <dt>{t("role")}</dt>
            <dd><span className="acct-badge" data-role={me.role}>{t(`roles.${me.role}`)}</span></dd>
          </div>
          <div><dt>{t("since")}</dt><dd>{since}</dd></div>
        </dl>
      </div>
    </section>
  );
}
