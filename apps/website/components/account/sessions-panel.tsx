"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ApiError, fetchSessions, revokeSession, type SessionInfo } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { describeUserAgent, relativeTime } from "@/lib/user-agent";
import { ConsoleSkeleton } from "./console-skeleton";

export function SessionsPanel() {
  const t = useTranslations("console");
  const locale = useLocale();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    fetchSessions().then(setSessions, (error) => {
      if (error instanceof ApiError && error.unauthorized) router.replace("/login");
      else setLoadFailed(true);
    });
  }, [router]);
  useEffect(load, [load]);

  const revoke = async (session: SessionInfo) => {
    setBusy(session.id);
    setFailed(null);
    try {
      await revokeSession(session.id);
      // Signing out the device you are on ends your own session too.
      if (session.current) router.replace("/login");
      else setSessions((list) => list?.filter((s) => s.id !== session.id) ?? null);
    } catch (error) {
      if (error instanceof ApiError && error.unauthorized) router.replace("/login");
      // 404 means it was already gone, which is what was asked for.
      else if (error instanceof ApiError && error.status === 404) setSessions((list) => list?.filter((s) => s.id !== session.id) ?? null);
      else setFailed(session.id);
    } finally {
      setBusy(null);
    }
  };

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const label = (s: SessionInfo) => {
    if (s.device_name) return s.device_name;
    const { browser, os } = describeUserAgent(s.user_agent);
    if (browser && os) return t("sessions.deviceLabel", { browser, os });
    return browser ?? os ?? t("sessions.unknownDevice");
  };

  return (
    <section aria-labelledby="sessions-title">
      <h1 id="sessions-title" className="acct-title">{t("sessions.title")}</h1>
      <p className="acct-sub">{t("sessions.lead")}</p>

      {loadFailed && (
        <div className="acct-status" role="alert">
          <p>{t("loadFailed")}</p>
          <button type="button" className="acct-quiet" onClick={load}>{t("retry")}</button>
        </div>
      )}
      {!loadFailed && sessions === null && <ConsoleSkeleton pathname="/console/sessions" label={t("loading")} body />}

      {sessions && (
        <ul className="acct-list">
          {sessions.map((s) => (
            <li key={s.id} className="acct-row" data-current={s.current || undefined}>
              <div className="acct-row-main">
                <p className="acct-row-title">
                  {label(s)}
                  {s.current && <span className="acct-badge" data-role="current">{t("sessions.current")}</span>}
                </p>
                <p className="acct-row-meta">
                  {s.kind !== "web" && <>{t(`sessions.kinds.${s.kind}`)} · </>}
                  {t("sessions.lastActive", { when: relativeTime(s.last_used_at, locale, new Date(), t("justNow")) })}
                  {" · "}
                  {t("sessions.signedIn", { date: date.format(new Date(s.created_at)) })}
                </p>
                {failed === s.id && <p className="acct-row-error" role="alert">{t("sessions.revokeFailed")}</p>}
              </div>
              <button type="button" className="acct-quiet" disabled={busy !== null} onClick={() => revoke(s)}>
                {busy === s.id ? t("sessions.revoking") : t("sessions.revoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
