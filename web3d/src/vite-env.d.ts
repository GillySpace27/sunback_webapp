/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ORIGINAL_SITE?: string;
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
