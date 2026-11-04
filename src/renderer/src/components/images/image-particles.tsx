import { memo, useEffect, useRef, type CSSProperties, type JSX } from "react";
import { cn } from "@/lib/utils";

type Particle = { x: number; y: number; radius: number; phase: number; speed: number };

/** A bounded canvas animation: no React renders per frame, and no work while off-screen. */
export const ImageParticles = memo(function ImageParticles({
  className,
  style,
  seed = 0,
  active = true,
}: {
  className?: string;
  style?: CSSProperties;
  seed?: number;
  active?: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx || !active) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let visible = true;
    let width = 1;
    let height = 1;
    let disposed = false;
    let lastFrame = 0;
    let particles: Particle[] = [];
    let ink = "";
    let glow = "";
    let background = "";
    const random = (index: number): number => {
      const value = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453;
      return value - Math.floor(value);
    };
    const readColors = (): void => {
      const styles = getComputedStyle(canvas);
      ink = styles.getPropertyValue("--foreground").trim();
      glow = styles.getPropertyValue("--primary").trim();
      background = styles.getPropertyValue("--muted").trim();
    };
    const paint = (now: number): void => {
      frame = 0;
      if (disposed) return;
      // Cap at 30fps even on 120Hz displays; phase derives from time, never frame count.
      if (!reduced.matches && now - lastFrame < 32) {
        frame = requestAnimationFrame(paint);
        return;
      }
      lastFrame = now;
      const time = reduced.matches ? seed * 0.3 : now * 0.00023 + seed;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 0.52;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      const cx = width * (0.5 + Math.sin(time * 0.75) * 0.14);
      const cy = height * (0.5 + Math.cos(time * 0.6) * 0.13);
      const radius = Math.max(width, height) * 0.75;
      const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      haze.addColorStop(0, glow);
      haze.addColorStop(1, "transparent");
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, width, height);
      for (const particle of particles) {
        const wave = Math.sin(particle.x * 7 + particle.phase + time * particle.speed);
        const drift = Math.cos(particle.y * 6 - particle.phase + time * 0.7);
        const x = particle.x * width + wave * width * 0.035;
        const y = particle.y * height + drift * height * 0.04;
        const field = 0.5 + 0.5 * Math.sin(particle.x * 8 + particle.y * 5 + time * 1.8 + wave);
        ctx.globalAlpha = 0.06 + field * 0.29;
        ctx.fillStyle = particle.phase > 3 ? glow : ink;
        ctx.beginPath();
        ctx.arc(x, y, particle.radius * (0.65 + field * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(paint);
    };
    const stop = (): void => { cancelAnimationFrame(frame); frame = 0; };
    const resume = (): void => {
      stop();
      if (!visible || document.hidden || disposed) return;
      frame = requestAnimationFrame(paint);
    };
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(1150, Math.max(160, Math.floor(width * height / 140)));
      particles = Array.from({ length: count }, (_, i) => ({
        x: random(i * 6 + 1), y: random(i * 6 + 2),
        radius: 0.35 + random(i * 6 + 3) * 0.8,
        phase: random(i * 6 + 4) * Math.PI * 2,
        speed: 0.5 + random(i * 6 + 5),
      }));
      readColors();
      resume();
    };
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) resume(); else stop();
    });
    intersection.observe(canvas);
    const themeObserver = new MutationObserver(() => { readColors(); resume(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-theme-kind"] });
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    resize();
    return () => {
      disposed = true;
      stop();
      sizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, [seed, active]);
  return <canvas ref={canvasRef} aria-hidden className={cn("pointer-events-none absolute inset-0 size-full", className)} style={style} />;
});
