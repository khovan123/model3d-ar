import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["components/model-viewer-ar.tsx"],
    rules: {
      "@typescript-eslint/no-this-alias": "off"
    }
  },
  {
    files: ["components/model-viewer-interaction.tsx"],
    rules: {
      "prefer-const": "off"
    }
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "data/**"])
]);
