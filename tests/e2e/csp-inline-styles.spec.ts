import { expect, test, type Page } from "@playwright/test";
import { authenticateAaisE2eActor } from "./aais-e2e-helpers";

type CapturedCspViolation = {
  blockedUri: string;
  effectiveDirective: string;
};

declare global {
  interface Window {
    __aaisCspViolations?: CapturedCspViolation[];
  }
}

async function readStyleAttributeViolations(page: Page) {
  return page.evaluate(() => (
    window.__aaisCspViolations?.filter((violation) => (
      violation.effectiveDirective === "style-src-attr"
    )) ?? []
  ));
}

test("strict CSP permits the login and authenticated editor workflows without inline styles", async ({ page }) => {
  await page.addInitScript(() => {
    window.__aaisCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__aaisCspViolations?.push({
        blockedUri: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
      });
    });
  });

  const loginResponse = await page.goto("/login");
  if (process.env.AAIS_E2E_BASE_URL) {
    expect(loginResponse?.headers()["content-security-policy"] ?? "")
      .toContain("style-src-attr 'none'");
  }
  await expect(page.getByRole("heading", { name: /欢迎来到 CAAIS/ })).toBeVisible();
  await expect(page.locator("main [style]")).toHaveCount(0);
  await expect.poll(() => readStyleAttributeViolations(page)).toEqual([]);

  await authenticateAaisE2eActor(page, {
    id: "csp-e2e",
    role: "student",
    displayName: "CSP E2E",
  });
  await page.goto("/learning");

  const learningShell = page.getByTestId("learning-shell");
  const splitLayout = page.getByTestId("learning-split-layout");
  const contentPanel = page.getByRole("complementary", { name: "学习内容与文档" });
  const separator = page.getByRole("separator", { name: "调整内容展示区域宽度" });
  await expect(learningShell).toBeVisible();
  await expect(splitLayout).toBeVisible();
  await expect(contentPanel).toBeVisible();
  await expect(separator).toBeVisible();
  await expect(learningShell.locator("[style]")).toHaveCount(0);

  const initialWidth = Number(await splitLayout.getAttribute("data-content-panel-width"));
  const initialPanelBox = await contentPanel.boundingBox();
  const separatorBox = await separator.boundingBox();
  expect(initialPanelBox).not.toBeNull();
  expect(separatorBox).not.toBeNull();

  await page.mouse.move(
    separatorBox!.x + separatorBox!.width / 2,
    separatorBox!.y + separatorBox!.height / 2,
  );
  await page.mouse.down();
  await expect(page.locator("body")).toHaveAttribute("data-aais-panel-resizing", "true");
  await page.mouse.move(
    separatorBox!.x + separatorBox!.width / 2 + 48,
    separatorBox!.y + separatorBox!.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(page.locator("body")).not.toHaveAttribute("data-aais-panel-resizing", "true");

  await expect.poll(async () => (
    Number(await splitLayout.getAttribute("data-content-panel-width"))
  )).toBeLessThan(initialWidth);
  const pointerWidth = Number(await splitLayout.getAttribute("data-content-panel-width"));
  const pointerPanelBox = await contentPanel.boundingBox();
  expect(pointerPanelBox).not.toBeNull();
  expect(pointerPanelBox!.width).toBeLessThan(initialPanelBox!.width);

  await separator.focus();
  await separator.press("ArrowLeft");
  await expect.poll(async () => (
    Number(await splitLayout.getAttribute("data-content-panel-width"))
  )).toBeGreaterThan(pointerWidth);

  await page.getByRole("button", { name: "文档编辑" }).click();
  const editor = page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  });
  await editor.fill("CSP formatting smoke test");

  await page.getByLabel("字体").selectOption("mono");
  await expect(editor).toHaveAttribute("data-font-family", "mono");
  await page.getByLabel("字号").selectOption("24");
  await expect(editor).toHaveAttribute("data-font-size", "24");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "居中" }).click();
  const alignedBlock = editor.locator('[align="center"]');
  await expect(alignedBlock).toHaveCount(1);
  expect(await alignedBlock.evaluate((element) => getComputedStyle(element).textAlign))
    .toMatch(/center$/);

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "右对齐" }).click();
  const rightAlignedBlock = editor.locator('[align="right"]');
  await expect(rightAlignedBlock).toHaveCount(1);
  expect(await rightAlignedBlock.evaluate((element) => getComputedStyle(element).textAlign))
    .toMatch(/right$/);

  await expect(learningShell.locator("[style]")).toHaveCount(0);
  await expect.poll(() => readStyleAttributeViolations(page)).toEqual([]);
});
