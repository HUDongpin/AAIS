import { expect, type Page, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

test("a targeted Professor turn shows a transient thinking bubble and replaces it in place", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const browserErrors = collectBrowserErrors(page);
  const releaseProfessorResponse = await deferProfessorResponse(page, {
    expectedMention: "@教授",
    responseContent: "A2 已用本地支架示范一次元认知拆解。",
    responseLabel: "教授",
    fallback: true,
  });
  await stubLearningSession(page);

  await authenticateAaisE2eActor(page, {
    id: "S001",
    role: "student",
    displayName: "Bobie",
  });
  await page.goto("/learning");
  await expect(page).toHaveURL(/\/learning$/);
  await waitForAaisLearningClientReady(page);

  await page.getByLabel("向智能导学输入你的想法").fill("@教授 请示范一次元认知拆解");
  await page.getByRole("button", { name: "发送" }).click();

  const thinkingText = page.getByText("教授正在思考", { exact: true });
  const indicator = page.locator('[data-guide-thinking-agent="A2"]');
  const pendingMessage = page.locator('[data-guide-message-kind="assistant"]', {
    has: thinkingText,
  });
  await expect(thinkingText).toBeVisible();
  await expect(indicator).toHaveCount(1);
  await expect(page.getByRole("img", { name: "教授大学教育风格头像" })).toBeVisible();
  await expect(page.getByText("智能导学处理中...", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/多智能体.*处理中/)).toHaveCount(0);
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeDisabled();
  const pendingMessageId = await pendingMessage.getAttribute("data-guide-message-id");
  expect(pendingMessageId).toBeTruthy();
  await expect.poll(() => indicator.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await page.screenshot({ path: test.info().outputPath("professor-thinking-1440x900-zh.png") });

  releaseProfessorResponse();

  await expect(page.getByText("离线支架模式")).toBeVisible();
  await expect(page.getByText("教授已用本地支架示范一次元认知拆解。")).toBeVisible();
  await expect(thinkingText).toHaveCount(0);
  await expect(page.getByLabel("向智能导学输入你的想法")).toBeEnabled();
  await expect(page.locator(`[data-guide-message-id="${pendingMessageId}"]`))
    .toContainText("教授已用本地支架示范一次元认知拆解。");
  expect(await hasNextErrorOverlay(page)).toBe(false);
  expect(browserErrors).toEqual([]);
});

test("the English Professor indicator fits a 375px viewport and becomes static with reduced motion", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const browserErrors = collectBrowserErrors(page);
  const releaseProfessorResponse = await deferProfessorResponse(page, {
    expectedMention: "@Professor",
    responseContent: "Professor completed the next-step check.",
    responseLabel: "Professor",
    fallback: false,
  });
  await stubLearningSession(page);

  await authenticateAaisE2eActor(page, {
    id: "S001",
    role: "student",
    displayName: "Bobie",
  });
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error("AAIS E2E base URL is required for locale setup.");
  }
  await context.addCookies([{
    name: "aais_locale",
    value: "en-US",
    url: baseURL,
    sameSite: "Lax",
  }]);
  await page.goto("/learning");
  await waitForAaisLearningClientReady(page);

  const guideInput = page.getByLabel("Share your thinking with the AI guide");
  await guideInput.fill("@Professor please check my next step");
  await page.getByRole("button", { name: "Send" }).click();

  const thinkingText = page.getByText("Professor is thinking", { exact: true });
  await expect(thinkingText).toBeVisible();
  const indicator = page.locator('[data-guide-thinking-agent="A2"]');
  const indicatorBox = await indicator.boundingBox();
  expect(indicatorBox).not.toBeNull();
  expect(indicatorBox!.x).toBeGreaterThanOrEqual(0);
  expect(indicatorBox!.x + indicatorBox!.width).toBeLessThanOrEqual(375);
  await expect(page.locator(".aais-guide-thinking-dot")).toHaveCount(3);
  const reducedMotionStyles = await indicator.evaluate((element) => ({
    bubbleAnimation: getComputedStyle(element).animationName,
    dotAnimation: getComputedStyle(
      element.querySelector(".aais-guide-thinking-dot") as Element,
    ).animationName,
    dotOpacity: getComputedStyle(
      element.querySelector(".aais-guide-thinking-dot") as Element,
    ).opacity,
  }));
  expect(reducedMotionStyles).toEqual({
    bubbleAnimation: "none",
    dotAnimation: "none",
    dotOpacity: "1",
  });
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
  const composerBefore = await guideInput.boundingBox();
  const pendingMessageId = await thinkingText
    .locator("xpath=ancestor::*[@data-guide-message-id][1]")
    .getAttribute("data-guide-message-id");
  expect(pendingMessageId).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath("professor-thinking-375x812-en-reduced.png") });

  releaseProfessorResponse();

  await expect(page.getByText("Professor completed the next-step check.", { exact: true })).toBeVisible();
  await expect(thinkingText).toHaveCount(0);
  await expect(guideInput).toBeEnabled();
  await expect(page.locator(`[data-guide-message-id="${pendingMessageId}"]`))
    .toContainText("Professor completed the next-step check.");
  const composerAfter = await guideInput.boundingBox();
  expect(Math.abs((composerAfter?.y ?? 0) - (composerBefore?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
  expect(await hasNextErrorOverlay(page)).toBe(false);
  expect(browserErrors).toEqual([]);
});

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const sourceURL = message.location().url;
      errors.push(sourceURL ? `${message.text()} @ ${sourceURL}` : message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}

async function hasNextErrorOverlay(page: Page) {
  return page.locator("nextjs-portal").evaluateAll((portals) =>
    portals.some((portal) => /Build Error|Runtime Error|Unhandled Runtime Error/i.test(
      portal.shadowRoot?.textContent ?? "",
    ))
  );
}

async function stubLearningSession(page: Page) {
  await page.route("**/api/learning/session", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          dataGeneration: 1,
          studentId: "S001",
          activeStage: "training",
          activeTaskId: "training_task_1",
          tasks: [],
          guideMessages: [],
          events: [],
        },
      }),
    });
  });
}

async function deferProfessorResponse(page: Page, input: {
  expectedMention: string;
  responseContent: string;
  responseLabel: string;
  fallback: boolean;
}) {
  let releaseProfessorResponse!: () => void;
  const professorResponseGate = new Promise<void>((resolve) => {
    releaseProfessorResponse = resolve;
  });

  await page.route("**/api/learning/ai-guide", async (route) => {
    const requestBody = JSON.parse(route.request().postData() ?? "{}") as {
      learnerInput?: string;
      targetAgentIds?: string[];
    };
    expect(requestBody.learnerInput).toContain(input.expectedMention);
    expect(requestBody.targetAgentIds).toEqual(["A2"]);
    await professorResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          text: "AAIS agents replied.",
        },
        turns: [{
          agentId: "A2",
          label: input.responseLabel,
          content: input.responseContent,
          actions: ["model", "coach"],
        }],
        orchestration: {
          graph: {
            graphId: "learning-ai-guide",
            topologicalOrder: ["A2"],
          },
          runtime: {
            timings: {
              fallback: input.fallback,
            },
          },
        },
      }),
    });
  });

  return releaseProfessorResponse;
}
