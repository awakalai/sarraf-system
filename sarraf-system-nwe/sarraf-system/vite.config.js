import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // esbuild left the application chunk just over the 500 kB production budget that
    // scripts/verify-production-readiness.mjs enforces. Terser compresses meaningfully
    // harder; console/debugger stripping also keeps operational detail out of a build
    // that handles customer financial data.
    minify: "terser",
    terserOptions: {
      compress: { passes: 2, drop_debugger: true, pure_funcs: ["console.debug", "console.info"] },
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/src/i18n/")) return "i18n";
          if (id.includes("/src/components/operations/")) return "operations-ui";
          if (id.includes("/src/components/receipts/")) return "receipts-ui";
          if (id.includes("/src/components/portal/")) return "portal-ui";
          if (id.includes("/src/components/market/")) return "market-ui";
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@supabase") || id.includes("iceberg-js")) return "supabase-vendor";
          if (id.includes("lucide-react")) return "icons-vendor";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
});
