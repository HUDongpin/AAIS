import { expect, test } from "./aais-e2e-fixtures";
import { getAaisE2eStudentAccount } from "./aais-e2e-helpers";

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
