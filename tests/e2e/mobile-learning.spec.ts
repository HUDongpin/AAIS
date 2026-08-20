import { expect, test } from "@playwright/test";
import { authenticateAaisE2eActor } from "./aais-e2e-helpers";

test.use({
  viewport: {
    width: 390,
    height: 844,
  },
});

const maxLengthMobileDisplayName = "学习者".repeat(40);

test("student learning cockpit remains usable on a phone-width viewport", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: `mobile-${Date.now()}`,
    role: "student",
    displayName: maxLengthMobileDisplayName,
  });

  await page.goto("/learning");

  await expect(page.getByTestId("learning-shell")).toBeVisible();
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeVisible();
  await expect(page.getByRole("button", { name: "内容展示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "文档编辑" })).toBeVisible();

  await page.getByRole("button", { name: "文档编辑" }).click();
  const documentActions = ["内容展示", "文档编辑", "保存并关闭", "下载到本地"];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const accountTrigger = page.getByRole("button", {
      name: `${maxLengthMobileDisplayName} 账户菜单`,
    });
    const accountBounds = await accountTrigger.boundingBox();
    expect(accountBounds).not.toBeNull();
    expect(accountBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((accountBounds?.x ?? width) + (accountBounds?.width ?? 1))
      .toBeLessThanOrEqual(width + 1);
    await expect(page.locator('[data-account-display-name="true"]'))
      .toHaveCSS("text-overflow", "ellipsis");

    for (const name of documentActions) {
      const action = page.getByRole("button", { name });
      await expect(action).toBeVisible();
      const bounds = await action.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? width) + (bounds?.width ?? 1)).toBeLessThanOrEqual(width + 1);
    }

    const documentEditorOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - window.innerWidth
    );
    expect(documentEditorOverflow).toBeLessThanOrEqual(1);
  }

  const horizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
