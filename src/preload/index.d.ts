import type { FastVibeApi } from "@shared/api";

declare global {
  interface Window {
    fastvibe: FastVibeApi;
  }
}

export {};
