import { expect, test } from "@playwright/test";
import { authenticateAaisE2eActor } from "./aais-e2e-helpers";

test("student artifact edit persists after reload", async ({ page }) => {
  const artifactText = `E2E artifact ${Date.now()}`;
  const studentId = `Persist${Date.now()}`;

  await authenticateAaisE2eActor(page, {
    id: studentId,
    role: "student",
    displayName: "Persistence E2E",
  });
  await page.goto("/learning");
  await expect(page).toHaveURL(/\/learning$/);

  await page.getByRole("button", { name: "文档编辑" }).click();
  const editor = page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  });
  await editor.fill(artifactText);
  await page.getByLabel("向智能导学输入你的想法").click();
  await page.waitForTimeout(800);

  await page.reload();
  await expect(page.getByTestId("learning-shell")).toBeVisible();
  await page.getByRole("button", { name: "文档编辑" }).click();
  await expect(editor).toContainText(artifactText);
});
