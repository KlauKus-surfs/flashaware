/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

// Globals injected at bundle time by Vite's `define` (see vite.config.ts).
// Both values land as string literals in the emitted JS.
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
