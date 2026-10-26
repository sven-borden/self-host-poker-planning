import { defineConfig } from "vite";

// In development the web app runs on 5173 and forwards the API and the socket to the
// server on 3000, so the browser sees a single origin, as it does in production.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": { target: "http://localhost:3000", ws: true },
    },
  },
});
