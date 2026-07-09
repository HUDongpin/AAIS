import { expect, test } from "@playwright/test";
import { loginWithAaisE2eStudent } from "./aais-e2e-helpers";

test("student can sign in and open the AAIS learning cockpit", async ({ page }) => {
  await loginWithAaisE2eStudent(page);

  await expect(page).toHaveURL(/\/learning$/);
  await expect(page.getByTestId("learning-shell")).toBeVisible();
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeVisible();
  await expect(page.getByText("导学智能体").first()).toBeVisible();
});
