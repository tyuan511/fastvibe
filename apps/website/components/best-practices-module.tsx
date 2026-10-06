import { useTranslations } from "next-intl";
import { AgentsIllustration, BrowserIllustration, PluginsIllustration, RemoteScene } from "./illustrations";

const items = [
  { id: "plugins", picture: <PluginsIllustration /> },
  { id: "agents", picture: <AgentsIllustration /> },
  { id: "remote", picture: <RemoteScene /> },
  { id: "browser", picture: <BrowserIllustration /> },
] as const;

export function BestPracticesModule() {
  const t = useTranslations("practices");

  return (
    <section aria-labelledby="practices-title" className="module practices-module" id="practices">
      <h2 id="practices-title" className="module-heading">{t("heading")}</h2>
      <div className="practice-list">
        {items.map(({ id, picture }) => (
          <article className="practice" key={id}>
            <div className="practice-copy">
              <h3>{t(`items.${id}.title`)}</h3>
              <p>{t(`items.${id}.description`)}</p>
            </div>
            <div className="practice-media" data-kind={id}>{picture}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
