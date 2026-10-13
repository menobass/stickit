import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Run from the repo root: `npm run pwa:dev` / `npm run pwa:build` (output in pwa/dist).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  server: { port: 5180, fs: { allow: [".."] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
