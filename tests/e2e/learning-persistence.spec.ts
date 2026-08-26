import { expect, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

test("student artifact edit persists after reload", async ({ page }) => {
  const artifactText = `E2E artifact ${Date.now()}`;
  const documentTitle = `E2E persistence ${Date.now()}`;
  const studentId = `Persist${Date.now()}`;
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat(?:e|ion)/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  await authenticateAaisE2eActor(page, {
    id: studentId,
    role: "student",
    displayName: "Persistence E2E",
  });
  await page.goto("/learning");
  await expect(page).toHaveURL(/\/learning$/);
  await waitForAaisLearningClientReady(page);

  await page.getByRole("button", { name: "文档编辑" }).click();
  const titleInput = page.getByLabel("文档标题");
  const editor = page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  });
  await titleInput.fill(documentTitle);
  await editor.fill(artifactText);
  await page.getByLabel("向智能导学输入你的想法").click();
  await expect(page.getByText("文档已保存。", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage)
      .some((key) => key.startsWith("aais_artifact_draft_v1:"))
  ))).toBe(false);

  await page.reload();
  await waitForAaisLearningClientReady(page);
  await page.getByRole("button", { name: "文档编辑" }).click();
  await expect(titleInput).toHaveValue(documentTitle);
  await expect(editor).toContainText(artifactText);
  expect(hydrationErrors).toEqual([]);
});
