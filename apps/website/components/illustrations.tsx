import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Icon, type IconName } from "./icons";

/*
 * Schematic pictures of each capability, drawn in markup so they follow the theme and
 * stay sharp at any size. They show the shape of the thing — rows, bars, chips — not the
 * app itself; the real interface is the hero. Words are limited to names that are the
 * same in every language (files, roles, providers).
 */

const bars = (widths: number[]) => widths.map((w, i) => <i key={i} className="illu-bar" style={{ width: `${w}%` }} />);

export function WorkspaceIllustration() {
  return (
    <div className="illu illu-workspace" aria-hidden="true">
      <div className="illu-pane illu-nav">
        <span className="illu-chip active" />
        {bars([70, 55, 80, 45])}
      </div>
      <div className="illu-pane illu-chat">
        <span className="illu-bubble">{bars([90, 60])}</span>
        <div className="illu-lines">{bars([100, 85, 94, 40])}</div>
        <div className="illu-tool"><Icon name="terminal" size={12} />{bars([48])}</div>
        <div className="illu-lines">{bars([88, 62])}</div>
        <span className="illu-input">{bars([36])}<b /></span>
      </div>
      <div className="illu-pane illu-files">
        <div className="illu-tabbar"><i className="active" /><i /></div>
        <div className="illu-code">
          {[[6, 38], [0, 62], [12, 46], [12, 70], [6, 24], [0, 54], [6, 40]].map(([indent, w], i) => (
            <span key={i} className="illu-code-line"><em>{i + 1}</em><i className="illu-bar" style={{ marginLeft: `${indent}%`, width: `${w}%` }} /></span>
          ))}
        </div>
        <div className="illu-tree">
          {[["folder", 40], ["file", 62], ["file", 52], ["file", 70]].map(([icon, w], i) => (
            <span key={i}><Icon name={icon as IconName} size={11} /><i className="illu-bar" style={{ width: `${w}%` }} /></span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ReviewIllustration() {
  const rows = [
    { kind: "ctx", n: 41, w: 70 }, { kind: "del", n: 42, w: 56 }, { kind: "add", n: 42, w: 72 },
    { kind: "add", n: 43, w: 48 }, { kind: "ctx", n: 44, w: 62 }, { kind: "ctx", n: 45, w: 30 },
  ] as const;
  return (
    <div className="illu illu-review" aria-hidden="true">
      <div className="illu-card">
        <div className="illu-card-head">
          <span className="illu-path"><Icon name="branch" size={13} />src/session.ts</span>
          <span className="illu-delta"><b className="add">+18</b><b className="del">−4</b></span>
        </div>
        <div className="illu-diff">
          {rows.map((row, i) => (
            <span key={i} className={`illu-diff-line ${row.kind}`}>
              <em>{row.n}</em><u>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</u><i className="illu-bar" style={{ width: `${row.w}%` }} />
            </span>
          ))}
        </div>
        <div className="illu-card-foot">
          <span className="illu-pill ok"><Icon name="check" size={12} />tests</span>
          <span className="illu-pill ok"><Icon name="check" size={12} />tsc</span>
          <span className="illu-pill solid"><Icon name="git" size={12} />commit</span>
        </div>
      </div>
    </div>
  );
}

export function ModelsIllustration() {
  const providers = [["Anthropic", true], ["OpenAI", true], ["DeepSeek", false], ["Gemini", true]] as const;
  return (
    <div className="illu illu-models" aria-hidden="true">
      <div className="illu-card">
        {providers.map(([name, on]) => (
          <span className="illu-row" key={name}>
            <i className="illu-dot" /><b>{name}</b>{bars([22])}<s className={on ? "on" : ""} />
          </span>
        ))}
        <div className="illu-levels">
          {["low", "medium", "high", "max"].map((level) => <span key={level} className={`illu-pill${level === "high" ? " solid" : ""}`}>{level}</span>)}
        </div>
      </div>
    </div>
  );
}

export function PluginsIllustration() {
  const plugins = [
    ["puzzle", "MCP", "a"],
    ["sparkles", "Skills", "b"],
    ["globe", "Web", "c"],
    ["terminal", "Shell", "d"],
  ] as const;
  return (
    <div className="illu illu-hub" aria-hidden="true">
      <svg className="hub-lines" viewBox="0 0 100 75" preserveAspectRatio="none">
        {[[22, 20], [78, 20], [22, 56], [78, 56]].map(([x, y]) => <path key={`${x}${y}`} d={`M50 38 C ${(50 + x) / 2} 38, ${x} ${(38 + y) / 2}, ${x} ${y}`} />)}
      </svg>
      <span className="hub-core"><span className="hub-ring" /><Image src="/brand/f-mark.png" alt="" width={56} height={56} /></span>
      {plugins.map(([icon, name, pos]) => (
        <span className={`hub-chip hub-${pos}`} key={name}>
          <span className="illu-tile"><Icon name={icon} size={16} /></span>
          <b>{name}</b>
          <i className="hub-live" />
        </span>
      ))}
    </div>
  );
}

export function AgentsIllustration() {
  const roles = [["explorer", 100, "done"], ["planner", 100, "done"], ["worker", 64, "run"], ["reviewer", 28, "run"]] as const;
  return (
    <div className="illu illu-agents" aria-hidden="true">
      <div className="illu-card illu-parent"><Icon name="layers" size={14} />{bars([46])}</div>
      <div className="illu-fan">
        {roles.map(([role, progress, state]) => (
          <div className="illu-card illu-role" key={role}>
            <span className={`illu-state ${state}`}>{state === "done" ? <Icon name="check" size={11} /> : null}</span>
            <b>{role}</b>
            <span className="illu-progress"><i style={{ width: `${progress}%` }} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The native phone app, photographed in the iOS Simulator against a stand-in machine
 * (`scripts/mobile-demo-server.mjs`). One capture per theme: CSS shows the one that matches
 * the page, and the other never loads because a hidden lazy image is not fetched.
 */
export function PhoneIllustration() {
  const t = useTranslations("practices");
  const locale = useLocale();
  const alt = t("items.remote.title");
  return (
    <div className="phone-shot">
      {(["light", "dark"] as const).map((theme) => (
        <Image key={theme} className={`only-${theme}`} src={`/mobile/${locale}/chat-${theme}.jpg`} alt={alt} width={720} height={1566} sizes="(max-width: 640px) 70vw, 288px" />
      ))}
    </div>
  );
}

/** The phone plus the two things it is for: knowing a task finished, and which machine it is on. */
export function RemoteScene() {
  const t = useTranslations("practices.mock");
  return (
    <>
      <PhoneIllustration />
      <span className="float-chip float-done"><span className="float-icon ok"><Icon name="check" size={13} /></span><b>{t("done")}</b></span>
      <span className="float-chip float-host"><i className="hub-live" /><Icon name="monitor" size={14} /><b>MacBook Pro</b></span>
    </>
  );
}

export function BrowserIllustration() {
  const t = useTranslations("practices.mock");
  return (
    <div className="mock-browser" aria-hidden="true">
      <div className="mock-browser-bar">
        <span className="traffic-lights"><span /><span /><span /></span>
        <span className="mock-address">http://localhost:3000</span>
      </div>
      <div className="mock-browser-page">
        <span className="mock-select">{t("inspect")}</span>
        <span className="mock-line wide" /><span className="mock-line" />
        <div className="mock-cards"><i /><i /><i /></div>
        <svg className="mock-cursor" width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6L5 3Z" /></svg>
      </div>
    </div>
  );
}
