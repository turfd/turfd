import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/turfd/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
