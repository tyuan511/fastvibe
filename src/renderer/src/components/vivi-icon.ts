import type { IconSvgElement } from "@hugeicons/react";

/** Vivi's blob and floating sparkle, simplified for the Hugeicons 24px stroke grid. */
export const ViviIcon = [
  ["path", {
    d: "M12 7C6.5 7 3 10.8 3 15.5C3 19.5 6.3 21 12 21C17.7 21 21 19.5 21 15.5C21 10.8 17.5 7 12 7Z",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    key: "body",
  }],
  ["path", {
    d: "M8.5 13.5V15M15.5 13.5V15M10 17.5Q12 19 14 17.5",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    key: "face",
  }],
  ["path", {
    d: "M18 2C18.4 4.1 18.9 4.6 21 5C18.9 5.4 18.4 5.9 18 8C17.6 5.9 17.1 5.4 15 5C17.1 4.6 17.6 4.1 18 2Z",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    key: "sparkle",
  }],
] as const satisfies IconSvgElement;
