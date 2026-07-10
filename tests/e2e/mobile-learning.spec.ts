import { expect, test } from "./aais-e2e-fixtures";
import { authenticateAaisE2eActor } from "./aais-e2e-helpers";

test.use({
  viewport: {
    width: 390,
    height: 844,
  },
});

test("student learning cockpit remains usable on a phone-width viewport", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: `mobile-${Date.now()}`,
    role: "student",
    displayName: "Mobile E2E",
  });

  await page.goto("/learning");

  await expect(page.getByTestId("learning-shell")).toBeVisible();
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeVisible();
  await expect(page.getByRole("button", { name: "内容展示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "文档编辑" })).toBeVisible();

  const horizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
