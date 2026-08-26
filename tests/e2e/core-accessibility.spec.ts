import { expect, type Page, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  getAaisE2eStudentAccount,
  getAaisE2eStudentPassword,
  stubLocalAaisCohortExport,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

test("login can be completed with keyboard focus and named landmarks", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("main", {
    name: /欢迎来到 CAAIS/,
  })).toBeVisible();
  await expect(page.locator("[data-client-ready]"))
    .toHaveAttribute("data-client-ready", "true");

  await page.getByLabel("账号").focus();
  await page.keyboard.type(getAaisE2eStudentAccount());
  await page.locator("#aais-login-password").focus();
  await page.keyboard.type(getAaisE2eStudentPassword());
  await page.getByRole("checkbox", { name: /用户协议和隐私政策/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "立即登录" }).focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/learning$/);
  await expect(page.getByRole("main", { name: "CAAIS 学习工作台" })).toBeVisible();
});

test("learning cockpit exposes a named main region and keyboard-operable content controls", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: `a11y-student-${Date.now()}`,
    role: "student",
    displayName: "A11y Student",
  });

  await page.goto("/learning");
  await waitForAaisLearningClientReady(page);

  const learningMain = page.getByRole("main", { name: "CAAIS 学习工作台" });
  await expect(learningMain).toBeVisible();
  await expect(learningMain).toHaveAttribute("aria-describedby", "aais-learning-description");
  await expect(page.getByRole("button", { name: "理论知识" })).toBeVisible();

  await page.getByRole("button", { name: "任务卡片" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "任务卡片" })).toBeVisible();
  await expect(page.getByRole("button", {
    name: "社交媒体与大学生心理健康课程论文大纲，已锁定",
  })).toBeDisabled();
  await expect(page.getByText(
    "先导实验阶段，任务3暂不开放，完成任务2后，会自动进入任务4",
  )).toBeVisible();
  await expect(page.getByRole("button", {
    name: "L2 挑战：执行与监控，暂不开放",
  })).toBeDisabled();

  await page.getByRole("button", { name: "文档编辑" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  })).toBeVisible();
});

test("legacy theory accessible name still opens the renamed task-card surface", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: `legacy-a11y-student-${Date.now()}`,
    role: "student",
    displayName: "Legacy A11y Student",
  });

  await page.goto("/learning");
  await waitForAaisLearningClientReady(page);

  await page.getByRole("button", { name: "理论知识" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "理论知识" })).toBeVisible();
});

test("teacher dashboard exposes a named main region and keyboard export path", async ({ page }) => {
  await authenticateAaisE2eActor(page, {
    id: "teacher-e2e",
    role: "teacher",
    displayName: "Teacher E2E",
  });
  await stubLocalAaisCohortExport(page);

  await page.goto("/dashboard");

  await expect(page.getByRole("main", { name: "教师看板" })).toBeVisible();
  await expect(page.getByLabel("Phase")).toBeVisible();
  await expect(page.getByLabel("Agent")).toBeVisible();
  await expect(page.getByLabel("Event")).toBeVisible();

  const csvButton = page.getByRole("button", { name: "CSV" });
  await expect(csvButton).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await csvButton.focus();
  await page.keyboard.press("Enter");
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/aais-cohort-analytics\.csv$/);
  await expect(page.getByText("CSV 已生成")).toBeVisible();
});

test("core screens meet minimum text contrast inside their main regions", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("main", { name: /欢迎来到 CAAIS/ })).toBeVisible();
  expect(await getContrastFailures(page, "main")).toEqual([]);

  await authenticateAaisE2eActor(page, {
    id: `contrast-student-${Date.now()}`,
    role: "student",
    displayName: "Contrast Student",
  });
  await page.goto("/learning");
  await waitForAaisLearningClientReady(page);
  await expect(page.getByRole("main", { name: "CAAIS 学习工作台" })).toBeVisible();
  expect(await getContrastFailures(page, "main")).toEqual([]);

  await authenticateAaisE2eActor(page, {
    id: "teacher-e2e",
    role: "teacher",
    displayName: "Teacher E2E",
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("main", { name: "教师看板" })).toBeVisible();
  expect(await getContrastFailures(page, "main")).toEqual([]);
});

type ContrastFailure = {
  background: string;
  color: string;
  fontSize: string;
  ratio: number;
  required: number;
  selector: string;
  text: string;
};

async function getContrastFailures(page: Page, rootSelector: string) {
  return page.evaluate((selector) => {
    type Rgba = {
      a: number;
      b: number;
      g: number;
      r: number;
    };

    function parseColor(value: string): Rgba | null {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) {
        return null;
      }
      const parts = match[1].split(",").map((part) => part.trim());
      const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
      const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
      if ([r, g, b, a].some((part) => Number.isNaN(part))) {
        return null;
      }
      return {
        r,
        g,
        b,
        a,
      };
    }

    function blend(foreground: Rgba, background: Rgba): Rgba {
      const alpha = foreground.a + background.a * (1 - foreground.a);
      if (alpha === 0) {
        return {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        };
      }
      return {
        r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
        g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
        b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
        a: alpha,
      };
    }

    function relativeLuminance(color: Rgba) {
      const channels = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    function contrastRatio(foreground: Rgba, background: Rgba) {
      const foregroundLuminance = relativeLuminance(foreground);
      const backgroundLuminance = relativeLuminance(background);
      const lighter = Math.max(foregroundLuminance, backgroundLuminance);
      const darker = Math.min(foregroundLuminance, backgroundLuminance);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function effectiveBackground(element: Element) {
      const ancestors: Element[] = [];
      let current: Element | null = element;
      while (current) {
        ancestors.unshift(current);
        current = current.parentElement;
      }
      return ancestors.reduce<Rgba>((background, ancestor) => {
        const color = parseColor(window.getComputedStyle(ancestor).backgroundColor);
        return color && color.a > 0 ? blend(color, background) : background;
      }, {
        r: 255,
        g: 255,
        b: 255,
        a: 1,
      });
    }

    function isVisible(element: HTMLElement) {
      if (element.closest("[hidden], [aria-hidden='true'], .sr-only")) {
        return false;
      }
      if (element.matches(":disabled")) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return false;
      }
      let current: HTMLElement | null = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.5) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    }

    function selectorFor(element: Element) {
      if (element.id) {
        return `#${element.id}`;
      }
      const label = element.getAttribute("aria-label");
      if (label) {
        return `${element.tagName.toLowerCase()}[aria-label="${label}"]`;
      }
      return element.tagName.toLowerCase();
    }

    const root = document.querySelector(selector);
    if (!root) {
      throw new Error(`Contrast root not found: ${selector}`);
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent?.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const failures: ContrastFailure[] = [];
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && isVisible(parent)) {
        const style = window.getComputedStyle(parent);
        const color = parseColor(style.color);
        const background = effectiveBackground(parent);
        const fontSize = Number.parseFloat(style.fontSize);
        const fontWeight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === "bold" ? 700 : 400);
        const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        const required = isLargeText ? 3 : 4.5;
        const ratio = color ? contrastRatio(color, background) : 0;
        if (ratio + 0.01 < required) {
          const text = node.textContent?.trim() ?? "";
          failures.push({
            background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
            color: style.color,
            fontSize: style.fontSize,
            ratio: Number(ratio.toFixed(2)),
            required,
            selector: selectorFor(parent),
            text: text.slice(0, 80),
          });
        }
      }
      node = walker.nextNode();
    }
    return failures;
  }, rootSelector);
}
