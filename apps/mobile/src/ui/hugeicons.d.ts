// The per-icon entry points of @hugeicons/core-free-icons have no .d.ts of their own.
declare module "@hugeicons/core-free-icons/*" {
  import type { IconSvgElement } from "@hugeicons/react-native";
  const icon: IconSvgElement;
  export default icon;
}
