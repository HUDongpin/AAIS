import { expect, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  loginWithAaisE2eStudent,
} from "./aais-e2e-helpers";

test("student account cannot open the teacher dashboard", async ({ page }) => {
  await loginWithAaisE2eStudent(page);
  await expect(page).toHaveURL(/\/learning$/);

  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/learning$/);
  await expect(page.getByRole("heading", { name: "教师看板" })).toBeHidden();
});

test("teacher smoke account can open cohort dashboard and export controls", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: "teacher-e2e",
    role: "teacher",
    displayName: "Teacher E2E",
  });

  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "教师看板" })).toBeVisible();
  await expect(page.getByLabel("Phase")).toBeVisible();
  await expect(page.getByLabel("Agent")).toBeVisible();
  await expect(page.getByLabel("Event")).toBeVisible();
  await expect(page.getByRole("button", { name: "CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JSON" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/aais-cohort-analytics\.csv$/);
  await expect(page.getByText("CSV 已生成")).toBeVisible();
});
