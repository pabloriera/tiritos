import { defineConfig } from "vite";

const serverPort = process.env.SERVER_PORT ?? "8080";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["melissia-prochurch-leena.ngrok-free.dev"],

    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },

      "/ws": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
});
