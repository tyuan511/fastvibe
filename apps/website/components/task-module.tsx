"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ModelsIllustration, ReviewIllustration, WorkspaceIllustration } from "./illustrations";

const scenes = [
  { id: "workspace", picture: <WorkspaceIllustration /> },
  { id: "review", picture: <ReviewIllustration /> },
  { id: "models", picture: <ModelsIllustration /> },
] as const;

/** Vertical tabs on the left, a schematic of the chosen capability on the right. */
export function TaskModule() {
  const t = useTranslations("tasks");
  const tf = useTranslations("features");
  const [active, setActive] = useState(0);

  return (
    <section aria-labelledby="tasks-title" className="module task-module" id="tasks">
      <h2 id="tasks-title" className="module-heading">{t("heading")}</h2>
      <div className="task-content">
        <div role="tablist" aria-orientation="vertical" className="task-tabs">
          {scenes.map(({ id }, index) => {
            const selected = active === index;
            return (
              <button
                key={id}
                id={`task-tab-${id}`}
                type="button"
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                aria-controls={`task-panel-${id}`}
                className="task-tab"
                onClick={() => setActive(index)}
                onKeyDown={(event) => {
                  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = (index + step + scenes.length) % scenes.length;
                  setActive(next);
                  document.getElementById(`task-tab-${scenes[next].id}`)?.focus();
                }}
              >
                <span className="task-tab-title">{tf(`${id}.title`)}</span>
                <span className="task-tab-reveal" data-open={selected || undefined}>
                  <span className="task-tab-description">{tf(`${id}.copy`)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="task-preview">
          {scenes.map(({ id, picture }, index) => (
            <div key={id} id={`task-panel-${id}`} role="tabpanel" aria-labelledby={`task-tab-${id}`} hidden={index !== active} className="illu-stage">
              {picture}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
