import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ["/api", "/ws", "/health"].map((path) => [
        path,
        {
          target: "http://127.0.0.1:8787",
          ws: path === "/ws",
          changeOrigin: true,
          // Local BE explicitly allows this origin. Browser sees one Vite origin.
          configure(proxy) {
            const setOrigin = (request: {
              setHeader(name: string, value: string): void;
            }) => request.setHeader("Origin", "http://127.0.0.1:8787");
            proxy.on("proxyReq", setOrigin);
            proxy.on("proxyReqWs", setOrigin);
          },
        },
      ]),
    ),
  },
});
