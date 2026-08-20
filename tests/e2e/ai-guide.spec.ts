import { expect, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

test("student guide turn shows fallback state when the AI route reports template guidance", async ({ page }) => {
  await page.route("**/api/learning/ai-guide", async (route) => {
    const requestBody = JSON.parse(route.request().postData() ?? "{}") as {
      learnerInput?: string;
      targetAgentIds?: string[];
    };
    expect(requestBody.learnerInput).toContain("@教授");
    expect(requestBody.targetAgentIds).toEqual(["A2"]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          text: "AAIS 智能体已回复。",
        },
        turns: [
          {
            agentId: "A2",
            label: "教授",
            content: "A2 已用本地支架示范一次元认知拆解。",
            actions: ["model", "coach"],
          },
        ],
        orchestration: {
          graph: {
            graphId: "learning-ai-guide",
            topologicalOrder: ["A2"],
          },
          runtime: {
            timings: {
              fallback: true,
            },
          },
        },
      }),
    });
  });

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

  await expect(page.getByText("离线支架模式")).toBeVisible();
  await expect(page.getByText("教授已用本地支架示范一次元认知拆解。")).toBeVisible();
});
