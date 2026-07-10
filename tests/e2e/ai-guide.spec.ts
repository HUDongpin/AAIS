import { expect, test } from "./aais-e2e-fixtures";
import { authenticateAaisE2eActor } from "./aais-e2e-helpers";

test("student guide turn shows fallback state when the AI route reports template guidance", async ({ page }) => {
  await page.route("**/api/learning/ai-guide", async (route) => {
    const requestBody = JSON.parse(route.request().postData() ?? "{}") as {
      learnerInput?: string;
      targetAgentIds?: string[];
    };
    expect(requestBody.learnerInput).toContain("@A2");
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
            label: "专家智能体",
            content: "A2 已用本地支架示范一次元认知拆解。",
            actions: ["model", "coach"],
          },
        ],
        orchestration: {
          graph: {
            graphId: "learning-ai-guide",
            topologicalOrder: ["A1", "A2", "A3", "A4"],
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

  await page.getByLabel("向智能导学输入你的想法").fill("@A2 请示范一次元认知拆解");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("离线支架模式")).toBeVisible();
  await expect(page.getByText("A2 已用本地支架示范一次元认知拆解。")).toBeVisible();
});
