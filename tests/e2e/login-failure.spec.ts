import { expect, test } from "@playwright/test";
import { getAaisE2eStudentAccount } from "./aais-e2e-helpers";

test("sign-in stays disabled until consent is acknowledged", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("账号").fill(getAaisE2eStudentAccount());
  await page.locator("#aais-login-password").fill("synthetic-password-not-submitted");
  const consent = page.getByRole("checkbox", { name: /用户协议和隐私政策/ });
  const submit = page.getByRole("button", { name: "立即登录" });

  await expect(consent).not.toBeChecked();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveCSS("cursor", "not-allowed");
  await expect(submit).toHaveCSS("background-color", "rgb(168, 184, 208)");

  await consent.check();
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveCSS("background-color", "rgb(31, 111, 235)");
});

test("bad trial password stays on login and shows safe copy", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("账号").fill(getAaisE2eStudentAccount());
  await page.locator("#aais-login-password").fill("wrong-password");
  await page.getByRole("checkbox", { name: /用户协议和隐私政策/ }).check();
  await page.getByRole("button", { name: "立即登录" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("账号或密码不匹配，请使用已授权的 CAAIS 账号登录。")).toBeVisible();
  await expect(page.getByTestId("learning-shell")).toHaveCount(0);
});
