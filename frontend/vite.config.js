import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Development keeps the API and native WebSocket on the browser's origin through Vite.
export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = loadEnv(mode, root, "");
  const backend = fileURLToPath(new URL("../backend/", import.meta.url));
  const backendEnv = loadEnv(mode, backend, "");
  const target = `http://127.0.0.1:${process.env.PORT ?? backendEnv.PORT ?? env.PORT ?? "3000"}`;
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy: { "/api": { target }, "/ws": { target, ws: true } } },
  };
});
