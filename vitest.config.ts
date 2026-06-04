import { defineConfig } from "vitest/config";

// Default `npm test` excludes the integration suite — those tests open real
// TestingBot sessions and burn paid minutes. Use `npm run test:integration`
// to run them (also requires RUN_INTEGRATION_TESTS=true and real creds).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "tests/"],
    },
  },
});
