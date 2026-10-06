import type { ReactNode, SVGProps } from "react";

type IconName =
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
  | "smartphone";

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
