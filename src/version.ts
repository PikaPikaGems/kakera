declare const __KAKERA_VERSION__: string | undefined;
/** Set by the consuming package's build; falls back to the workspace version in source tests. */
export const VERSION = typeof __KAKERA_VERSION__ === "string" ? __KAKERA_VERSION__ : "0.0.0";
