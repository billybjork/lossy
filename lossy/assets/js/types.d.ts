// Type declarations for modules without types

declare module "phoenix-colocated/lossy" {
  import type { HooksOptions } from "phoenix_live_view";
  export const hooks: HooksOptions;
}

declare module "*/vendor/topbar.cjs" {
  interface Topbar {
    config(options: { barColors: Record<number, string>; shadowColor: string }): void;
    show(delay?: number): void;
    hide(): void;
  }
  const topbar: Topbar;
  export = topbar;
}

// Declare process.env for esbuild define
declare const process: {
  env: {
    NODE_ENV?: string;
  };
};
