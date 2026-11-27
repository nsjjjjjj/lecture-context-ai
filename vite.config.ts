import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export const DEFAULT_LOCAL_API_PORT = 8787;

export function resolveLocalApiPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : DEFAULT_LOCAL_API_PORT;
}

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), "");
  const apiPort = resolveLocalApiPort(process.env.PORT || fileEnvironment.PORT);

  return {
    root: "client",
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "../dist/client",
      emptyOutDir: true
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
        "/ws": {
          target: `ws://127.0.0.1:${apiPort}`,
          ws: true
        }
      }
    }
  };
});
