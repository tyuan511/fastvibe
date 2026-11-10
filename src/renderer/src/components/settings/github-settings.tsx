import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowUpRight01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./settings-group";

const APP_SETTINGS_URL = "https://github.com/settings/apps/fastvibe-vivi";
const INSTALLATIONS_URL = "https://github.com/settings/installations";

/**
 * GitHub App 关联.
 *
 * Vivi 以 GitHub App 的机器人身份工作：它需要自己的账号来提交 Review、合并 PR 和关闭
 * Issue，而不是借用你的个人凭据。这一页只负责把「需要哪些权限」和「改完权限为什么还不
 * 生效」讲清楚——真正的注册与安装走 `scripts/vivi-github-app-register.ts`，凭据落在
 * userData 的独立文件里，不经过设置。
 *
 * 权限清单来自 2026-11-10 的真实闭环验收，不是猜测：
 * - `contents: write` 合并 PR 时写默认分支需要；
 * - `pull_requests: write` 提交 Review 与合并；
 * - `checks: read` 读取 PR 的 CI 结论；
 * - `statuses: read` 合并前置检查会读 commit statuses，缺它会直接 403。
 */
export function GithubSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const open = (url: string): void => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        <HugeiconsIcon strokeWidth={2} icon={GitBranchIcon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium">{t("github.title")}</h2>
          <p className="text-xs leading-5 text-muted-foreground">{t("github.description")}</p>
        </div>
      </div>

      <SettingsGroup title={t("github.permissions")}>
        {(["contents", "pullRequests", "checks", "statuses"] as const).map((id) => (
          <SettingsRow
            key={id}
            title={t(`github.permissionNames.${id}`)}
            description={t(`github.permissionDescriptions.${id}`)}
            control={
              <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                {t(`github.permissionValues.${id}`)}
              </span>
            }
          />
        ))}
      </SettingsGroup>

      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t("github.reinstallTitle")}</p>
          <p className="text-xs leading-5 text-muted-foreground">{t("github.reinstallDescription")}</p>
        </div>
      </div>

      <SettingsGroup title={t("github.links")}>
        <SettingsRow
          title={t("github.openAppSettings")}
          description={t("github.openAppSettingsDescription")}
          control={
            <Button type="button" variant="outline" size="sm" onClick={() => open(APP_SETTINGS_URL)}>
              {t("github.open")}
              <HugeiconsIcon strokeWidth={2} icon={ArrowUpRight01Icon} data-icon="inline-end" />
            </Button>
          }
        />
        <SettingsRow
          title={t("github.manageInstallations")}
          description={t("github.manageInstallationsDescription")}
          control={
            <Button type="button" variant="outline" size="sm" onClick={() => open(INSTALLATIONS_URL)}>
              {t("github.open")}
              <HugeiconsIcon strokeWidth={2} icon={ArrowUpRight01Icon} data-icon="inline-end" />
            </Button>
          }
        />
      </SettingsGroup>

      <p className="px-1 text-xs leading-5 text-muted-foreground">{t("github.registerHint")}</p>
    </div>
  );
}
