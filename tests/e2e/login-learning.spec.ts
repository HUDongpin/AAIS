import { expect, test } from "@playwright/test";
import {
  loginWithAaisE2eStudent,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

test("student can sign in and open the CAAIS learning cockpit", async ({ page }) => {
  await loginWithAaisE2eStudent(page);

  await expect(page).toHaveURL(/\/learning$/);
  await waitForAaisLearningClientReady(page);
  await expect(page.getByTestId("learning-shell")).toBeVisible();
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeVisible();
  await expect(page.getByText("小张").first()).toBeVisible();
});
