import { useEffect, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { LinkSquare02Icon, Login01Icon, Logout01Icon, User02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useAccount } from "@/lib/use-account";
import { cn } from "@/lib/utils";
import type { AccountState, AccountUser } from "@shared/account";

/** The GitHub avatar, or the person's initial when the picture is missing or fails to load. */
function Avatar({ user, className }: { user: AccountUser; className?: string }): JSX.Element {
  return user.avatarUrl ? (
    <img
      src={user.avatarUrl}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      className={cn("shrink-0 rounded-full bg-muted object-cover", className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground",
        className,
      )}
    >
      {user.login.slice(0, 1)}
    </span>
  );
}

/**
 * The FastVibe account, at the right end of the sidebar's footer row.
 *
 * Signed in, it is the person's avatar and a popover with who they are, a link to the
 * console and 退出登录. Signed out it is a plain person glyph that starts the browser
 * sign-in. Nothing here ever sees the token — Main keeps it, and only describes the user.
 */
export function SidebarAccount(): JSX.Element | null {
  const { t } = useTranslation("app");
  const account = useAccount();
  const previous = useRef<AccountState["status"] | null>(null);

  // The browser flow ends somewhere else and then lifts the app back up; a toast is what
  // says the thing the person went off to do has worked.
  useEffect(() => {
    if (!account) return;
    if (previous.current === "signing-in" && account.status === "signed-in" && account.user) {
      toast.success(t("account.signedInToast", { login: account.user.login }));
    }
    previous.current = account.status;
  }, [account, t]);

  if (!account) return null;
  const user = account.user;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-full pointer-coarse:size-10"
            title={user && account.status === "signed-in" ? user.login : t("account.signIn")}
            aria-label={user && account.status === "signed-in" ? t("account.menuLabel", { login: user.login }) : t("account.signIn")}
          />
        }
      >
        {account.status === "signing-in" ? (
          <Spinner className="size-3.5" />
        ) : account.status === "signed-in" && user ? (
          <Avatar user={user} className="size-5" />
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={User02Icon} className="size-3.5 text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 gap-1.5 p-2">
        {account.status === "signed-in" && user ? <SignedIn account={account} user={user} /> : <SignedOut account={account} />}
      </PopoverContent>
    </Popover>
  );
}

function SignedIn({ account, user }: { account: AccountState; user: AccountUser }): JSX.Element {
  const { t } = useTranslation("app");
  return (
    <>
      <div className="flex items-center gap-2.5 p-1.5">
        <Avatar user={user} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.login}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email ?? t("account.noEmail")}</p>
        </div>
      </div>
      <Separator />
      <Button
        variant="ghost"
        size="sm"
        className="justify-start gap-2"
        render={<a href={`${account.origin}/console`} target="_blank" rel="noreferrer" />}
        nativeButton={false}
      >
        <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} className="size-3.5 text-muted-foreground" />
        {t("account.console")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="justify-start gap-2"
        onClick={() => void window.fastvibe.account.logout()}
      >
        <HugeiconsIcon strokeWidth={2} icon={Logout01Icon} className="size-3.5 text-muted-foreground" />
        {t("account.signOut")}
      </Button>
    </>
  );
}

function SignedOut({ account }: { account: AccountState }): JSX.Element {
  const { t } = useTranslation("app");
  const waiting = account.status === "signing-in";
  return (
    <div className="flex flex-col gap-2 p-1.5">
      <div>
        <p className="text-sm font-medium">{t("account.signedOutTitle")}</p>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
          {waiting ? t("account.waiting") : t("account.signedOutDesc")}
        </p>
      </div>
      {account.error ? (
        <p role="alert" className="text-xs leading-4 text-destructive">
          {account.error}
        </p>
      ) : null}
      {waiting ? (
        <Button variant="outline" size="sm" onClick={() => void window.fastvibe.account.cancelLogin()}>
          {t("account.cancel")}
        </Button>
      ) : (
        <Button size="sm" className="gap-2" onClick={() => void window.fastvibe.account.login()}>
          <HugeiconsIcon strokeWidth={2} icon={Login01Icon} className="size-3.5" />
          {t("account.signIn")}
        </Button>
      )}
    </div>
  );
}
