import { createHmac } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

type AaisE2eActor = {
  id: string;
  role: "student" | "teacher" | "admin";
  displayName: string;
};

const sessionCookieName = "aais_session";
const csrfCookieName = "aais_csrf";
const devSessionSecret = "aais-dev-session-secret-do-not-use-for-production";
const sessionTtlSeconds = 60 * 60 * 8;

export async function loginWithTrialAccount(
  page: Page,
  account: string,
  password: string,
) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /欢迎来到 CAAIS/ })).toBeVisible();
  await page.getByLabel("账号").fill(account);
  await page.locator("#aais-login-password").fill(password);
  await page.getByRole("checkbox", { name: /用户协议和隐私政策/ }).check();
  await page.getByRole("button", { name: "立即登录" }).click();
}

export async function loginWithAaisE2eStudent(page: Page) {
  const credentials = readAaisE2eCredentials("student") ?? {
    account: "Bobie",
    password: "12345",
  };
  await loginWithTrialAccount(page, credentials.account, credentials.password);
}

export function getAaisE2eStudentAccount() {
  return readAaisE2eCredentials("student")?.account ?? "Bobie";
}

export function getAaisE2eStudentPassword() {
  return readAaisE2eCredentials("student")?.password ?? "12345";
}

export async function authenticateAaisE2eActor(page: Page, actor: AaisE2eActor) {
  if (process.env.AAIS_E2E_BASE_URL) {
    const credentials = readAaisE2eCredentials(actor.role);
    if (!credentials) {
      throw new Error(`AAIS ${actor.role} E2E credentials are required for deployed E2E.`);
    }
    await loginWithTrialAccount(page, credentials.account, credentials.password);
    await expect(page).toHaveURL(/\/learning$/);
    return;
  }
  await seedAaisSession(page, actor);
}

export async function stubLocalAaisCohortExport(page: Page) {
  if (process.env.AAIS_E2E_BASE_URL) {
    return;
  }
  await page.route("**/api/learning/export?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/csv;charset=utf-8",
      headers: {
        "content-disposition": 'attachment; filename="aais-cohort-analytics.csv"',
      },
      body: "learner_key,risk_level\nlearner-e2e,on-track\n",
    });
  });
}

export async function waitForAaisLearningClientReady(page: Page) {
  const shell = page.getByTestId("learning-shell");
  await expect(shell).toHaveAttribute("data-client-ready", "true");
  await expect(shell).toHaveAttribute("data-session-ready", "true");
}

export async function seedAaisSession(page: Page, actor: AaisE2eActor) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error("AAIS E2E baseURL is required to seed session cookies.");
  }
  const csrfToken = createAaisE2eCsrfToken(actor.id);
  await page.context().addCookies([
    {
      name: sessionCookieName,
      value: createAaisE2eSessionToken(actor),
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: csrfCookieName,
      value: csrfToken,
      url: baseURL,
      sameSite: "Lax",
    },
    {
      name: "aais_student_id",
      value: actor.id,
      url: baseURL,
      sameSite: "Lax",
    },
    {
      name: "aais_display_name",
      value: actor.displayName,
      url: baseURL,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(({ actorId, displayName }) => {
    window.localStorage.setItem("aais_student_id", actorId);
    window.localStorage.setItem("aais_display_name", displayName);
  }, {
    actorId: actor.id,
    displayName: actor.displayName,
  });
}

function createAaisE2eSessionToken(actor: AaisE2eActor) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 3,
    actor,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
    authSource: "development",
  };
  return signPayload(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
}

function createAaisE2eCsrfToken(studentId: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub: studentId,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
  };
  return signPayload(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
}

function readAaisE2eCredentials(role: AaisE2eActor["role"]) {
  const prefix = role === "student"
    ? "AAIS_E2E_STUDENT"
    : "AAIS_E2E_TEACHER";
  const account = process.env[`${prefix}_ACCOUNT`]?.trim();
  const password = process.env[`${prefix}_PASSWORD`]?.trim();
  if (!account || !password) {
    return null;
  }
  return {
    account,
    password,
  };
}

function signPayload(encodedPayload: string) {
  const signature = createHmac("sha256", process.env.AAIS_SESSION_SECRET?.trim() || devSessionSecret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
