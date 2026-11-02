import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  FastVibeMascot,
  MASCOT_PALETTES,
  type FastVibeMascotPalette,
  type FastVibeMascotStatus,
} from "@/components/fastvibe-mascot";
import currentIcon from "@/assets/f-mark.png";
import { cn } from "@/lib/utils";
import "@/index.css";

/** `mock.html?mascot=1`: the Vivi design board. */

const STATES: Array<{ id: FastVibeMascotStatus; name: string; note: string; maps: string }> = [
  { id: "idle", name: "空闲", note: "慢慢呼吸，偶尔眨眼", maps: "没有任务" },
  { id: "thinking", name: "思考", note: "盯着闪光，闪光在转", maps: "推理中" },
  { id: "working", name: "执行", note: "一蹦一蹦地干活", maps: "调用工具" },
  { id: "waiting", name: "等你", note: "晃脑袋，闪光一闪一闪", maps: "等待操作" },
  { id: "success", name: "完成", note: "跳起来，闪光炸开", maps: "回复完成" },
  { id: "error", name: "出错", note: "塌下来，冒一滴冷汗", maps: "运行失败" },
];

const PALETTES: Array<{ id: FastVibeMascotPalette; name: string; stage: string }> = [
  { id: "sky", name: "天空", stage: "#e1edff" },
  { id: "grape", name: "葡萄", stage: "#efe6ff" },
  { id: "mint", name: "薄荷", stage: "#dbf5ee" },
  { id: "peach", name: "蜜桃", stage: "#ffe8df" },
  { id: "cloud", name: "云朵", stage: "#e6ebf7" },
];

const SIDEBAR: Array<{ status: FastVibeMascotStatus; title: string; meta: string; tone?: "warning" | "danger" }> = [
  { status: "working", title: "修复登录页报错", meta: "运行中" },
  { status: "waiting", title: "迁移数据库 schema", meta: "等你确认", tone: "warning" },
  { status: "thinking", title: "调研 WebRTC 中转", meta: "思考中" },
  { status: "success", title: "写本周周报", meta: "已完成" },
  { status: "error", title: "部署到测试环境", meta: "出错了", tone: "danger" },
  { status: "idle", title: "整理 README", meta: "昨天" },
];

const SIZES = [16, 20, 24, 32, 48, 64];

function swatch(palette: FastVibeMascotPalette): string {
  const colors = MASCOT_PALETTES[palette];
  return `linear-gradient(135deg, ${colors.light}, ${colors.mid} 52%, ${colors.deep})`;
}

function delay(seconds: number): CSSProperties {
  return { "--fv-mascot-delay": `${-seconds}s` } as CSSProperties;
}

/** The mascot as the bot's avatar in a conversation. */
function ChatMock(): JSX.Element {
  return (
    <div className="flex flex-col gap-5 rounded-3xl bg-white p-6">
      <p className="text-[12px] font-medium text-[#8a8fa3]">对话里的 bot 头像</p>
      <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-[#eef1f8] px-4 py-2.5 text-[14px] leading-6">
        登录页一直报 401，帮我看看
      </div>
      <div className="flex items-start gap-3">
        <FastVibeMascot status="working" size="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">Vivi</p>
          <p className="mt-1 text-[14px] leading-6 text-[#3d4256]">找到了：token 过期后没有刷新。我改一下拦截器，再跑一遍测试。</p>
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-[#f5f6fa] px-3 py-2 text-[12px] text-[#6b7085]">
            <span className="size-1.5 animate-pulse rounded-full bg-[#4f9bff]" />
            正在运行 pnpm test
          </div>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <FastVibeMascot status="waiting" size="size-9 shrink-0" style={delay(0.6)} />
        <div className="min-w-0 flex-1 rounded-2xl border border-[#f1d9a6] bg-[#fffaf0] px-4 py-3">
          <p className="text-[13px] font-semibold text-[#9a6200]">等你确认</p>
          <p className="mt-1 text-[14px] leading-6 text-[#3d4256]">测试全过了，要我提交并推送吗？</p>
          <div className="mt-2.5 flex gap-2">
            <span className="rounded-lg bg-[#1b1e2b] px-3 py-1 text-[12px] text-white">提交并推送</span>
            <span className="rounded-lg border border-[#e3e5ee] bg-white px-3 py-1 text-[12px] text-[#4a5066]">先不用</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The mascot living on the desktop, perched on a window edge and speaking up when something happens. */
function DesktopPet(): JSX.Element {
  return (
    <div className="relative aspect-[16/9] overflow-hidden rounded-3xl bg-[linear-gradient(140deg,#9fd3ff_0%,#b9b4ff_45%,#ffc6dc_100%)] max-md:aspect-[4/5]">
      <div className="absolute left-[8%] top-[22%] h-[62%] w-[56%] rounded-2xl bg-white/85 shadow-[0_24px_60px_-24px_rgba(40,40,120,0.45)] backdrop-blur max-md:left-[6%] max-md:top-[30%] max-md:h-[48%] max-md:w-[80%]">
        <div className="flex gap-1.5 px-4 py-3">
          <span className="size-2.5 rounded-full bg-[#ff6159]" />
          <span className="size-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="space-y-2.5 px-5 pt-2">
          <div className="h-2.5 w-[55%] rounded-full bg-[#e3e6f0]" />
          <div className="h-2.5 w-[80%] rounded-full bg-[#e3e6f0]" />
          <div className="h-2.5 w-[68%] rounded-full bg-[#e3e6f0]" />
          <div className="h-2.5 w-[40%] rounded-full bg-[#e3e6f0]" />
        </div>
      </div>
      {/* Perched on the window's top edge: the feet sit on the line. */}
      <div className="absolute left-[50%] top-[22%] w-[13%] -translate-y-[88%] max-md:left-[62%] max-md:top-[30%] max-md:w-[24%]">
        <div className="absolute bottom-[96%] right-[72%] w-max rounded-2xl rounded-br-md bg-white px-3.5 py-2 text-[13px] text-[#1b1e2b] shadow-[0_10px_24px_-12px_rgba(40,40,120,0.5)]">
          测试全过了！
        </div>
        <FastVibeMascot status="success" size="aspect-square h-auto w-full" />
      </div>
      <div className="absolute bottom-[7%] right-[6%] flex items-end gap-2">
        <div className="mb-[38%] rounded-2xl rounded-br-md bg-white/90 px-3 py-1.5 text-[12px] text-[#6b7085] shadow-[0_10px_24px_-12px_rgba(40,40,120,0.5)]">
          在想…
        </div>
        <FastVibeMascot status="thinking" palette="grape" size="size-16 max-md:size-12" style={delay(1.1)} />
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-16">
      <div className="mb-5 flex items-baseline justify-between gap-6 max-md:block">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h2>
        <p className="text-[13px] text-[#8a8fa3] max-md:mt-1.5">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Hero(): JSX.Element {
  const [status, setStatus] = useState<FastVibeMascotStatus>("idle");
  const [palette, setPalette] = useState<FastVibeMascotPalette>("sky");
  const stage = PALETTES.find((item) => item.id === palette)?.stage;
  const state = STATES.find((item) => item.id === status);
  return (
    <section className="grid grid-cols-[1fr_1.05fr] items-center gap-8 rounded-[32px] bg-white px-14 py-12 shadow-[0_30px_70px_-40px_rgba(40,52,120,0.35)] max-md:grid-cols-1 max-md:px-6 max-md:py-8">
      <div>
        <p className="text-[13px] font-medium text-[#8a8fa3]">FastVibe 的小伙伴</p>
        <h1 className="mt-3 text-[64px] font-semibold leading-none tracking-[-0.04em] max-md:text-[48px]">Vivi</h1>
        <p className="mt-2 text-lg text-[#9aa0b4]">Vibe Blob</p>
        <p className="mt-6 max-w-[360px] text-[15px] leading-7 text-[#555b70]">
          一团软乎乎的小家伙，头顶飘着一颗闪光。它是 FastVibe 里每个 bot 的样子，也会住在你的桌面上：想事情时闪光会转，等你回答时闪光会一闪一闪。
        </p>
        <p className="mt-8 text-[12px] font-medium text-[#8a8fa3]">心情</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {STATES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStatus(item.id)}
              className={cn(
                "cursor-pointer rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                status === item.id ? "border-[#1b1e2b] bg-[#1b1e2b] text-white" : "border-[#e3e5ee] text-[#4a5066] hover:border-[#c4c8d8]",
              )}
            >
              {item.name}
            </button>
          ))}
        </div>
        <p className="mt-6 text-[12px] font-medium text-[#8a8fa3]">颜色</p>
        <div className="mt-2.5 flex gap-2.5">
          {PALETTES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.name}
              title={item.name}
              onClick={() => setPalette(item.id)}
              className={cn(
                "size-8 cursor-pointer rounded-full transition",
                palette === item.id ? "ring-2 ring-[#1b1e2b] ring-offset-2" : "ring-1 ring-black/10 hover:scale-105",
              )}
              style={{ background: swatch(item.id) }}
            />
          ))}
        </div>
      </div>
      <div className="relative grid aspect-square place-items-center">
        <div className="absolute inset-[7%] rounded-full transition-[background] duration-500" style={{ background: stage }} />
        <FastVibeMascot status={status} palette={palette} shadow size="relative size-[76%]" label={`Vivi · ${state?.name ?? ""}`} />
      </div>
    </section>
  );
}

function SidebarMock({ dark }: { dark?: boolean }): JSX.Element {
  return (
    <div className={cn("rounded-3xl p-3", dark ? "bg-[#15171e] text-[#e7e9f0]" : "bg-white text-[#1b1e2b]")}>
      <p className={cn("px-2.5 pb-2 pt-1 text-[12px] font-medium", dark ? "text-[#7d8296]" : "text-[#8a8fa3]")}>
        {dark ? "侧栏 · 深色" : "侧栏 · 浅色"}
      </p>
      {SIDEBAR.map((row, index) => (
        <div
          key={row.title}
          className={cn("flex h-9 items-center gap-2.5 rounded-xl px-2.5", index === 0 && (dark ? "bg-white/[0.07]" : "bg-[#f1f3f8]"))}
        >
          <FastVibeMascot status={row.status} size="size-5" style={delay(index * 0.45)} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{row.title}</span>
          <span
            className={cn(
              "shrink-0 text-[11px]",
              row.tone === "warning" ? "text-[#d48806]" : row.tone === "danger" ? "text-[#e5484d]" : dark ? "text-[#7d8296]" : "text-[#9aa0b4]",
            )}
          >
            {row.meta}
          </span>
        </div>
      ))}
    </div>
  );
}

function MascotPreview(): JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-[#f4f5f9] font-sans text-[#1b1e2b] antialiased">
      <div className="mx-auto max-w-[1080px] px-8 pb-24 pt-8 max-md:px-4">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5 text-[14px]">
            <img src={currentIcon} alt="" className="size-7" />
            <span className="font-semibold">FastVibe</span>
            <span className="text-[#a0a4b5]">/ 角色设计</span>
          </div>
          <span className="rounded-full bg-white px-3 py-1 text-[12px] text-[#6b7085]">第 2 版草案</span>
        </header>

        <Hero />

        <Section title="六种心情" note="每种心情对应一个 agent 状态，脸和动作一起变。">
          <div className="grid grid-cols-3 gap-4 max-md:grid-cols-2">
            {STATES.map((item) => (
              <div key={item.id} className="rounded-3xl bg-white p-2">
                <div className="grid aspect-[4/3] place-items-center rounded-[20px] bg-[#f3f6fd]">
                  <FastVibeMascot status={item.id} shadow size="aspect-square h-auto w-[48%]" />
                </div>
                <div className="flex items-start justify-between gap-3 px-3 pb-2 pt-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">{item.name}</p>
                    <p className="mt-0.5 text-[13px] text-[#8a8fa3]">{item.note}</p>
                  </div>
                  <span className="mt-0.5 shrink-0 rounded-full bg-[#f1f2f7] px-2 py-0.5 text-[11px] text-[#6b7085]">{item.maps}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="一家子" note="多个 agent 一起干活时，每个换一种颜色，轮廓和表情不变。">
          <div className="flex flex-wrap items-end justify-around gap-y-6 rounded-3xl bg-[#e9eefa] px-6 pb-6 pt-10">
            {PALETTES.map((item, index) => (
              <div key={item.id} className="flex flex-col items-center gap-3">
                <FastVibeMascot palette={item.id} shadow size="size-[120px] max-md:size-[88px]" style={delay(index * 0.7)} />
                <span className="text-[13px] text-[#6b7085]">{item.name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="桌面萌宠" note="趴在窗口边上陪你，任务有进展时冒个气泡。">
          <DesktopPet />
        </Section>

        <Section title="作为 bot" note="对话里的头像跟着状态动，侧栏一眼看出每个 agent 在干什么。">
          <div className="grid grid-cols-[1.1fr_0.9fr] gap-4 max-md:grid-cols-1">
            <ChatMock />
            <div className="grid grid-rows-2 gap-4">
              <SidebarMock />
              <SidebarMock dark />
            </div>
          </div>
        </Section>

        <Section title="小尺寸" note="头像最常见的是 16–32px，闪光和眼睛在 16px 还认得出来。">
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            {[false, true].map((dark) => (
              <div key={String(dark)} className={cn("flex items-end justify-between rounded-3xl px-8 pb-5 pt-8 max-md:px-5", dark ? "bg-[#15171e]" : "bg-white")}>
                {SIZES.map((px) => (
                  <div key={px} className="flex flex-col items-center gap-3">
                    <FastVibeMascot motion={false} size="" style={{ width: px, height: px }} />
                    <span className={cn("text-[11px] tabular-nums", dark ? "text-[#7d8296]" : "text-[#8a8fa3]")}>{px}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<MascotPreview />);
