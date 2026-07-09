import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.AAIS_E2E_PORT ?? 3000);
const baseURL = process.env.AAIS_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const e2eSmokeAccountsJson = JSON.stringify([
  {
    id: "teacher-e2e",
    displayName: "Teacher E2E",
    role: "teacher",
    password: {
      algorithm: "scrypt",
      salt: "aais-e2e-teacher",
      hash: "XSSw1hd1nwysYN_XtFjgeqpQ_JpmMk8swytjML3HytI",
    },
  },
]);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: process.env.AAIS_E2E_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          AAIS_DATA_DIR: ".aais-e2e-data",
          AAIS_TRIAL_SMOKE_ACCOUNTS_JSON: e2eSmokeAccountsJson,
        },
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
