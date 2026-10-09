"use client";

import Image from "next/image";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { fetchMe } from "@/lib/api";
import { Link, useRouter } from "@/i18n/navigation";
import { Icon } from "../icons";
import { LanguageSwitch } from "../language-switch";
import { ThemeSwitch } from "../theme-switch";

/** What the API redirects here with (`/login?error=<code>`); anything else reads as "unknown". */
const ERRORS = ["invalid_state", "github_denied", "github_rejected", "github_unavailable", "account_disabled", "internal_error"] as const;
type ErrorCode = (typeof ERRORS)[number];
const isErrorCode = (value: string): value is ErrorCode => (ERRORS as readonly string[]).includes(value);

export function LoginCard({ error }: { error?: string }) {
  const t = useTranslations("login");
  const router = useRouter();

  // Someone who is already signed in has no use for this page.
  useEffect(() => {
    let cancelled = false;
    fetchMe().then(() => { if (!cancelled) router.replace("/console"); }, () => {});
    return () => { cancelled = true; };
  }, [router]);

  const message = error ? t(`errors.${isErrorCode(error) ? error : "unknown"}`) : null;
  // A plain link, not a router transition: this navigates the whole page to the API,
  // which redirects to GitHub. return_to is a path on this site; the API refuses anything else.
  const start = `/api/auth/github/start?return_to=${encodeURIComponent("/console")}`;

  return (
    <div className="acct-center">
      <div className="acct-corner"><LanguageSwitch /><ThemeSwitch /></div>
      <section className="acct-card" aria-labelledby="login-title">
        <Image className="acct-mark" src="/brand/f-mark.png" alt="" width={44} height={44} priority />
        <h1 id="login-title">{t("title")}</h1>
        <p className="acct-lead">{t("lead")}</p>
        {message && <p className="acct-alert" role="alert">{message}</p>}
        <a className="acct-primary" href={start}>
          <Icon name="github" size={18} />
          <span>{t("github")}</span>
        </a>
        <Link className="acct-back" href="/">{t("home")}</Link>
      </section>
    </div>
  );
}
