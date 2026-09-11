import type { FastVibeApi } from "./index";

declare global {
  interface Window {
    fastvibe: FastVibeApi;
  }
}

export {};
