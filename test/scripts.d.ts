declare module "*scripts/wrappers.mjs" {
  export function wrapperFiles(): Promise<Map<string, string | Buffer>>;
}

declare module "*scripts/logo-sprite.mjs" {
  export function logoSymbol(name: string, source: string): string;
  export function logoSprite(logos: readonly { name: string; svg: string }[]): string;
}

declare module "*scripts/search-runtime.mjs" {
  export const SUPPORTED_PLATFORMS: readonly string[];
  export function isSupportedPlatform(platform?: string, arch?: string): boolean;
  export function selectPlatformFiles(
    platformKey: string,
    entries: readonly string[],
  ): { binding: string[]; libs: string[] };
  export function buildSearchRuntime(options?: {
    root?: string;
    packageRoot?: string;
    binRoot?: string;
    platform?: string;
    arch?: string;
    checkLoad?: boolean;
    writeNotices?: boolean;
  }): Promise<{
    supported: boolean;
    platform: string;
    copied: string[];
    loadChecked: boolean;
  }>;
}

declare module "*live/checks.mjs" {
  export const CHECKS: readonly {
    tool: string;
    args: Record<string, unknown>;
    note?: string;
    replay?: boolean;
    replayNote?: string;
  }[];
  export const SKIPPED: readonly { tool: string; reason: string }[];
  export const EXPENSIVE: readonly string[];
}
