"use client";

import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

/*
 * The shader is ReactBits' "Iridescence" background (https://reactbits.dev/backgrounds/iridescence,
 * MIT + Commons Clause), adapted for this page: eased pointer response read from the window
 * (the hero ignores pointer events), a live colour for the theme, rendering that stops
 * off-screen, a single still frame under reduced motion, and a quiet exit when WebGL is
 * missing — the static gradient in the CSS is what remains.
 */

const vertex = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragment = `
precision highp float;
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uResolution;
uniform vec2 uMouse;
uniform float uAmplitude;
uniform float uSpeed;
varying vec2 vUv;
void main() {
  float mr = min(uResolution.x, uResolution.y);
  vec2 uv = (vUv.xy * 2.0 - 1.0) * uResolution.xy / mr;
  uv += (uMouse - vec2(0.5)) * uAmplitude;
  float d = -uTime * 0.5 * uSpeed;
  float a = 0.0;
  for (float i = 0.0; i < 8.0; ++i) {
    a += cos(i - d - a * uv.x);
    d += sin(uv.y * i + a);
  }
  d += uTime * 0.5 * uSpeed;
  vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
  col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5) * uColor;
  gl_FragColor = vec4(col, 1.0);
}
`;

const LIGHT: [number, number, number] = [0.5, 0.78, 1];
const DARK: [number, number, number] = [0.14, 0.26, 0.7];
const isDark = () => getComputedStyle(document.documentElement).colorScheme.startsWith("dark");

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function HeroBackdrop() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    const hero = host?.parentElement;
    if (!host || !hero || !webglAvailable()) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new Renderer({ dpr: 1, antialias: false });
    const gl = renderer.gl;
    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color(...(isDark() ? DARK : LIGHT)) },
        uResolution: { value: new Color(1, 1, 1) },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uAmplitude: { value: 0.2 },
        uSpeed: { value: 0.7 },
      },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
    host.appendChild(gl.canvas);

    let frame = 0;
    let visible = true;
    let elapsed = 6;
    let last = performance.now();
    const target = { x: 0.5, y: 0.5 };
    const mouse = { x: 0.5, y: 0.5 };

    const draw = (now: number) => {
      frame = 0;
      const dt = Math.min(now - last, 50);
      last = now;
      if (!reduced) {
        elapsed += dt / 1000;
        mouse.x += (target.x - mouse.x) * 0.06;
        mouse.y += (target.y - mouse.y) * 0.06;
      }
      program.uniforms.uTime.value = elapsed;
      program.uniforms.uMouse.value[0] = mouse.x;
      program.uniforms.uMouse.value[1] = mouse.y;
      renderer.render({ scene: mesh });
      host.dataset.ready = "true";
      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };
    const start = () => { if (!frame) { last = performance.now(); frame = requestAnimationFrame(draw); } };

    const resize = () => {
      renderer.setSize(host.offsetWidth, host.offsetHeight);
      program.uniforms.uResolution.value = new Color(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height);
      if (reduced) start();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const recolor = () => {
      program.uniforms.uColor.value = new Color(...(isDark() ? DARK : LIGHT));
      if (reduced) start();
    };
    const themeObserver = new MutationObserver(recolor);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", recolor);

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const rect = hero.getBoundingClientRect();
      target.x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      target.y = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
    };
    const onLeave = () => { target.x = 0.5; target.y = 0.5; };
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible && !reduced) start(); });
    intersection.observe(hero);
    if (!reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.documentElement.addEventListener("mouseleave", onLeave);
      start();
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      intersection.disconnect();
      media.removeEventListener("change", recolor);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      gl.canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <div className="hero-glow" ref={root} aria-hidden="true" />;
}
