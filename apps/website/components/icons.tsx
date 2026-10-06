import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "arrow-up-right"
  | "arrow-right"
  | "arrow-down"
  | "download"
  | "github"
  | "sparkles"
  | "terminal"
  | "layers"
  | "shield"
  | "globe"
  | "puzzle"
  | "check"
  | "external"
  | "command"
  | "menu"
  | "smartphone"
  | "apple"
  | "windows"
  | "linux"
  | "folder"
  | "clock"
  | "plus"
  | "monitor"
  | "cube"
  | "x"
  | "chevron-down"
  | "paperclip"
  | "sun"
  | "moon"
  | "branch"
  | "git"
  | "android";

const paths: Record<IconName, ReactNode> = {
  "arrow-up-right": <><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>,
  "arrow-right": <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  "arrow-down": <><path d="M12 5v14" /><path d="m18 13-6 6-6-6" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  github: <><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.7-1.6 6.7-7A5.4 5.4 0 0 0 19.3 4 5 5 0 0 0 19.2.4S18 0 15 2.1a13.4 13.4 0 0 0-6 0C6 0 4.8.4 4.8.4A5 5 0 0 0 4.7 4 5.4 5.4 0 0 0 3.3 7.5c0 5.4 3.4 6.6 6.7 7A4.8 4.8 0 0 0 9 18v4" /><path d="M9 18c-4.5 2-5-2-7-2" /></>,
  sparkles: <><path d="m12 3-1.2 4.3L7 9l3.8 1.7L12 15l1.2-4.3L17 9l-3.8-1.7L12 3Z" /><path d="m19 14-.7 2.3L16 17l2.3.7L19 20l.7-2.3L22 17l-2.3-.7L19 14Z" /><path d="m5 3-.6 1.9L2.5 5.5l1.9.6L5 8l.6-1.9 1.9-.6-1.9-.6L5 3Z" /></>,
  terminal: <><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.3 2.5 3.4 5.5 3.4 9s-1.1 6.5-3.4 9c-2.3-2.5-3.4-5.5-3.4-9S9.7 5.5 12 3Z" /></>,
  puzzle: <><path d="M19.5 13.5a2.5 2.5 0 1 0 0-5H17V6a2.5 2.5 0 1 0-5 0v2.5H9.5a2.5 2.5 0 1 0 0 5H12V16a2.5 2.5 0 1 0 5 0v-2.5h2.5Z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  external: <><path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
  command: <><path d="M18 4a3 3 0 1 0-3 3h3V4ZM6 20a3 3 0 1 0 3-3H6v3ZM6 4a3 3 0 1 1 3 3H6V4ZM18 20a3 3 0 1 1-3-3h3v3Z" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  smartphone: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M10 18h4" /></>,
  apple: <path d="M17.1 12.8c0-2 1.6-3 1.7-3.1-1-1.5-2.5-1.7-3.1-1.7-1.3-.1-2.5.8-3.2.8-.6 0-1.7-.8-2.8-.8C8.2 8 6.8 9 6 10.3c-1.6 2.7-.4 6.8 1.2 9 .7 1.1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.8-.7s1.7.7 2.9.7c1.2 0 1.9-1 2.6-2.1.9-1.2 1.2-2.4 1.2-2.5-.1 0-2.3-.9-2.3-4ZM15.1 6.5c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.6-1.2 1.8-1.1 2.8 1 .1 2.1-.5 2.8-1.2Z" fill="currentColor" stroke="none" />,
  windows: <path d="m2 4 9-1.2v8.3H2V4Zm10-1.4L22 1v10.1H12V2.6ZM2 12.2h9v8.4L2 19.3v-7.1Zm10 0h10V23l-10-1.6v-9.2Z" fill="currentColor" stroke="none" />,
  linux: <path fill="currentColor" stroke="none" fillRule="evenodd" d="M12 1.8c-2.3 0-3.7 1.9-3.7 4.4 0 1.1-.3 1.9-1 3-1.2 1.6-2.4 3.5-2.4 5.9 0 1.1.3 2 .8 2.8-.9.5-2 1.1-2 2 0 1.3 1.8 1.4 3.1 1.6 1 .2 1.6.9 2.8.9.9 0 1.5-.5 2-1.1h.8c.5.6 1.1 1.1 2 1.1 1.2 0 1.8-.7 2.8-.9 1.3-.2 3.1-.3 3.1-1.6 0-.9-1.1-1.5-2-2 .5-.8.8-1.7.8-2.8 0-2.4-1.2-4.3-2.4-5.9-.7-1.1-1-1.9-1-3 0-2.5-1.4-4.4-3.7-4.4ZM12 10.2c-1.8 0-3.2 2-3.2 4.4s1.4 4 3.2 4 3.2-1.6 3.2-4-1.4-4.4-3.2-4.4ZM10.5 5.6a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm3 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6ZM10.8 7.7 12 7.1l1.2.6-1.2 1-1.2-1Z" />,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  plus: <path d="M5 12h14M12 5v14" />,
  monitor: <><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></>,
  git: <><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>,
  android: <path d="M6 18c0 .55.45 1 1 1h1v3.5a1.5 1.5 0 0 0 3 0V19h2v3.5a1.5 1.5 0 0 0 3 0V19h1c.55 0 1-.45 1-1V8H6v10ZM3.5 8A1.5 1.5 0 0 0 2 9.5v7a1.5 1.5 0 0 0 3 0v-7A1.5 1.5 0 0 0 3.5 8Zm17 0A1.5 1.5 0 0 0 19 9.5v7a1.5 1.5 0 0 0 3 0v-7A1.5 1.5 0 0 0 20.5 8ZM15.53 2.16l1.3-1.3a.5.5 0 0 0-.7-.7l-1.48 1.48A5.96 5.96 0 0 0 12 1c-.96 0-1.86.23-2.66.64L7.85.16a.5.5 0 0 0-.7.7l1.3 1.3A5.98 5.98 0 0 0 6 7h12c0-2.0-.98-3.77-2.47-4.84ZM10 5H9V4h1v1Zm5 0h-1V4h1v1Z" fill="currentColor" stroke="none" />,
  cube: <><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z" /><path d="m3.3 7 8.7 5 8.7-5M12 12v9" /></>,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  paperclip: <path d="m21.4 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />,
};

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
