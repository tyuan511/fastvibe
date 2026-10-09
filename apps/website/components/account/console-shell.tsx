"use client";

import Image from "next/image";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ApiError, fetchMe, signOut, type Me } from "@/lib/api";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { writeViewerHint } from "@/lib/viewer";
import { LanguageSwitch } from "../language-switch";
import { ThemeSwitch } from "../theme-switch";
import { ConsoleSkeleton } from "./console-skeleton";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; me: Me };

const MeContext = createContext<Me | null>(null);

/** The signed-in user. Only valid below ConsoleShell, which renders children once it has one. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside ConsoleShell");
  return me;
}

const NAV = [
  { href: "/console/account", key: "account" },
  { href: "/console/sessions", key: "sessions" },
  { href: "/console/more", key: "more" },
] as const;

/**
 * The console's frame and its only gate. The pages are static; whether you may see them
 * is decided here, by asking the API who you are. A 401 sends you to sign in, anything
 * else offers a retry instead of pretending you were signed out.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const t = useTranslations("console");
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetchMe()
      .then((me) => {
        writeViewerHint(me);
        setState({ status: "ready", me });
      })
      .catch((error) => {
        if (error instanceof ApiError && error.unauthorized) {
          writeViewerHint(null);
          router.replace("/login");
        } else {
          setState({ status: "error" });
        }
      });
  }, [router]);

  useEffect(load, [load]);

  const leave = async () => {
    try {
      await signOut();
    } finally {
      writeViewerHint(null);
      router.replace("/login");
    }
  };

  const me = state.status === "ready" ? state.me : null;

  return (
    <div className="acct-shell">
      <header className="acct-header">
        <div className="acct-header-inner">
          <Link className="brand" href="/" aria-label="FastVibe">
            <Image src="/brand/f-mark.png" alt="" width={28} height={28} priority />
            <span>FastVibe</span>
          </Link>
          <nav className="acct-nav" aria-label={t("label")}>
            {NAV.map(({ href, key }) => (
              <Link key={key} href={href} aria-current={pathname.startsWith(href) ? "page" : undefined}>
                {t(`nav.${key}`)}
              </Link>
            ))}
          </nav>
          <div className="acct-header-actions">
            <LanguageSwitch />
            <ThemeSwitch />
            {me && (
              <>
                <span className="acct-user" title={me.login}>
                  {me.avatar_url && (
                    // eslint-disable-next-line @next/next/no-img-element -- a 28px avatar from GitHub's CDN; next/image would proxy it for nothing
                    <img src={me.avatar_url} alt="" width={28} height={28} referrerPolicy="no-referrer" />
                  )}
                  <span>{me.login}</span>
                </span>
                <button type="button" className="acct-quiet" onClick={leave}>{t("signOut")}</button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="acct-main" id="main-content">
        {state.status === "loading" && <ConsoleSkeleton pathname={pathname} label={t("loading")} />}
        {state.status === "error" && (
          <div className="acct-status" role="alert">
            <p>{t("loadFailed")}</p>
            <button type="button" className="acct-quiet" onClick={load}>{t("retry")}</button>
          </div>
        )}
        {state.status === "ready" && <MeContext.Provider value={state.me}>{children}</MeContext.Provider>}
      </main>
    </div>
  );
}
