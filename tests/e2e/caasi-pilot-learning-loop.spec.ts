import { expect, type Page, test } from "@playwright/test";
import {
  authenticateAaisE2eActor,
  waitForAaisLearningClientReady,
} from "./aais-e2e-helpers";

const taskIds = {
  training: "training_task_1",
  taskTwo: "practice_task_1",
  taskThree: "practice_task_2",
  taskFour: "practice_task_3",
} as const;

test.describe("CAAIS pilot learning loop", () => {
  test.skip(
    Boolean(process.env.AAIS_E2E_BASE_URL),
    "The pilot learning-loop acceptance uses local synthetic learners only.",
  );

  test("completes the AI-free pilot path, generates the A4 report, and persists the summary", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const studentId = "caasi-pilot-loop-" + Date.now();
    const pageErrors: string[] = [];
    let guideRouteRequests = 0;
    const guideRequestBodies: GuideRequestSnapshot[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/learning/ai-guide")) {
        guideRouteRequests += 1;
        guideRequestBodies.push(readGuideRequestSnapshot(request.postData()));
      }
    });

    await authenticateAaisE2eActor(page, {
      id: studentId,
      role: "student",
      displayName: "小张",
    });
    await page.goto("/learning");
    await expect(page).toHaveURL(/\/learning$/);
    await waitForAaisLearningClientReady(page);

    await page.getByRole("button", { name: "平台介绍" }).click();
    await expect(page.getByRole("heading", {
      name: "从专家示范到独立总结",
    })).toBeVisible();
    const orientationButton = page.getByRole("button", {
      name: "我已理解学习流程",
    });
    await expect(orientationButton).toBeEnabled();
    await orientationButton.click();
    await expect(page.getByRole("button", {
      name: "启动说明已确认",
    })).toBeDisabled();
    await expect(page.locator('[data-pilot-milestone="launch_import"]'))
      .toHaveAttribute("data-milestone-status", "completed");

    await openTaskCardsFromArticle(page);
    const trainingCard = getTaskCard(page, taskIds.training);
    const trainingComplete = trainingCard.getByRole("button", {
      name: "完成任务：专家示范后的案例训练",
    });
    await expect(trainingCard.getByRole("heading", { name: /圆的面积/ })).toBeVisible();
    await expect(trainingCard).toContainText("具有小学数学教学与教育测量经验");
    await expect(trainingComplete).toBeDisabled();
    await trainingCard.getByRole("button", {
      name: "我已阅读并比较专家示范",
    }).click();
    await expect(trainingCard.getByRole("button", {
      name: "专家示范已完成",
    })).toBeDisabled();
    await expect(trainingComplete).toBeEnabled();
    await trainingComplete.click();

    const taskTwoCard = getTaskCard(page, taskIds.taskTwo);
    await expect(trainingCard).toHaveAttribute("data-task-status", "completed");
    await expect(trainingCard).toHaveAttribute(
      "data-completion-outcome",
      "evidence_complete",
    );
    await expect(taskTwoCard).toHaveAttribute("data-task-status", "available");
    await taskTwoCard.getByRole("button", {
      name: "进入任务：社交媒体与大学生心理健康课程论文大纲",
    }).click();

    await expect(page.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    })).toBeVisible();
    await openTaskCards(page);
    await expect(taskTwoCard).toHaveAttribute("data-task-status", "active");
    const taskTwoComplete = taskTwoCard.getByRole("button", {
      name: "完成任务：社交媒体与大学生心理健康课程论文大纲",
    });
    await expect(taskTwoComplete).toBeDisabled();
    await expect(taskTwoCard).toContainText("完成前还缺少");
    await expect(taskTwoCard.getByText("指出原提示词的不足并说明理由", {
      exact: true,
    })).toBeVisible();

    const scaffoldButton = taskTwoCard.getByRole("button", {
      name: /获取下一步支架|进入自检式帮助/,
    });
    for (const level of [1, 2, 3, 4]) {
      await scaffoldButton.click();
      await expect(taskTwoCard.getByText("支架等级 L" + level, {
        exact: true,
      })).toBeVisible();
    }
    await expect(taskTwoCard.getByText(
      "直接支架已用完；接下来先说明卡点，再进入自检式帮助。",
      { exact: true },
    )).toBeVisible();
    await expect(scaffoldButton).toHaveText("进入自检式帮助");
    await scaffoldButton.click();
    await expect(taskTwoCard.getByText("已提供“独立自检”支架。", {
      exact: true,
    })).toBeVisible();

    await taskTwoCard.getByRole("radio", {
      name: "不使用实时 GenAI",
    }).check();
    await taskTwoCard.locator("#practice_task_1-diagnosisText").fill(
      "原提示词缺少受众、篇幅、论证范围和质量标准，因而结果容易笼统。",
    );
    await taskTwoCard.locator("#practice_task_1-revisedPromptText").fill(
      "请面向大学二年级学生生成一份结构化论文大纲，限定范围、篇幅、证据类型并给出各部分论证重点。",
    );
    await taskTwoCard.locator("#practice_task_1-outputEvaluationText").fill(
      "我按目标覆盖、结构完整、证据可核查和篇幅适切四项标准检查输出，并指出需要修订之处。",
    );
    await taskTwoCard.locator("#practice_task_1-articulationText").fill(
      "我先明确产出和约束，再监控各部分是否偏离目标，最后依据评价标准决定保留或修订。",
    );
    await taskTwoCard.getByRole("button", {
      name: "保存学习证据",
    }).click();
    await expect(taskTwoCard.getByText(
      "学习证据已保存，完成门槛已由服务器重新计算。",
      { exact: true },
    )).toBeVisible();
    await expect(taskTwoCard.getByText(
      "服务器确认当前任务的必需证据已经齐全。",
      { exact: true },
    )).toBeVisible();
    const aiFreeGuideInput = page.getByLabel("向智能导学输入你的想法");
    const aiFreeAssistantCount = await page.locator(
      '[data-guide-message-kind="assistant"]',
    ).count();
    const aiFreeResponsePromise = waitForGuideResponse(
      page,
      "我正在用静态量规核对目标、约束与评价依据。",
    );
    await aiFreeGuideInput.fill("我正在用静态量规核对目标、约束与评价依据。");
    await page.getByRole("button", { name: "发送" }).click();
    const aiFreeResponse = await aiFreeResponsePromise;
    expect(aiFreeResponse.status()).toBe(200);
    await expect(page.locator('[data-guide-message-kind="assistant"]'))
      .toHaveCount(aiFreeAssistantCount + 1);
    await expect(aiFreeGuideInput).toBeEnabled();
    const aiFreeBudget = await readGuideResponseBudget(aiFreeResponse);
    expect(aiFreeBudget.used).toBe(0);
    expect(aiFreeBudget.remaining).toBe(aiFreeBudget.limit);
    expect(guideRequestBodies).toEqual([
      expect.objectContaining({
        dataGeneration: expect.any(Number),
        learnerInput: "我正在用静态量规核对目标、约束与评价依据。",
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        taskId: taskIds.taskTwo,
        targetAgentIds: ["A1"],
      }),
    ]);
    expect(guideRequestBodies[0]?.dataGeneration).toBeGreaterThanOrEqual(1);

    await expect(taskTwoComplete).toBeEnabled();
    await taskTwoComplete.click();

    const taskThreeCard = getTaskCard(page, taskIds.taskThree);
    const taskFourCard = getTaskCard(page, taskIds.taskFour);
    await expect(taskTwoCard).toHaveAttribute("data-task-status", "completed");
    await expect(taskTwoCard).toHaveAttribute(
      "data-completion-outcome",
      "evidence_complete",
    );
    await expect(taskThreeCard).toHaveAttribute("data-task-status", "locked");
    await expect(taskThreeCard).toHaveAttribute(
      "data-task-availability",
      "pilot-closed",
    );
    await expect(taskThreeCard.getByRole("button", {
      name: /任务3.*暂不开放/,
    })).toBeDisabled();
    await expect(taskFourCard).toHaveAttribute("data-task-status", "active");
    const afterTaskTwo = await readLearningSession(page);
    const openedTaskFour = requireTaskSnapshot(afterTaskTwo, taskIds.taskFour);
    expect(requireTaskSnapshot(afterTaskTwo, taskIds.taskTwo)).toMatchObject({
      status: "completed",
      completionOutcome: "evidence_complete",
    });
    expect(afterTaskTwo.activeTaskId).toBe(taskIds.taskFour);
    expect(openedTaskFour.activeMilestone).toBe("exploration");
    expect(openedTaskFour.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "exploration", status: "open" }),
    ]));
    await taskFourCard.getByRole("button", {
      name: "继续任务：设计一份《大学生GenAI学习使用指南》",
    }).click();

    const editor = page.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    const taskFourArtifact = createTaskFourArtifact();
    expect(countVisibleCharacters(taskFourArtifact)).toBeGreaterThanOrEqual(800);
    await editor.fill(taskFourArtifact);
    await expect(page.getByText("文档已保存。", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await openTaskCards(page);
    await expect(taskFourCard).toHaveAttribute("data-task-status", "active");
    await expect(taskFourCard.locator("#practice_task_3-reflectionText")).toHaveCount(0);
    await expect(taskFourCard.locator("#practice_task_3-expertComparisonText")).toHaveCount(0);
    const taskFourComplete = taskFourCard.getByRole("button", {
      name: "完成任务：设计一份《大学生GenAI学习使用指南》",
    });
    await expect(taskFourComplete).toBeDisabled();

    await taskFourCard.getByRole("radio", {
      name: "不使用实时 GenAI",
    }).check();
    await taskFourCard.getByRole("button", {
      name: "保存前置证据并生成对照报告",
    }).click();
    await expect(taskFourCard.getByText("请填写这项学习证据。", {
      exact: true,
    })).toBeVisible();
    await expect(taskFourComplete).toBeDisabled();

    await taskFourCard.locator("#practice_task_3-planningText").fill(
      "我先确定指南受众、学习目标、章节结构和不可逾越的学术诚信边界。",
    );
    await taskFourCard.locator("#practice_task_3-monitoringText").fill(
      "我逐段核查建议是否可操作、来源是否可追溯，并在偏离目标时及时调整。",
    );
    await taskFourCard.locator("#practice_task_3-evaluationText").fill(
      "我依据完整性、合理性、可操作性与责任边界四项标准评价最终指南。",
    );
    await taskFourCard.locator("#practice_task_3-outputEvaluationText").fill(
      "在 AI-free 路径中，我仍用静态示范识别常见输出的偏差、局限与核查责任。",
    );
    await taskFourCard.locator("#practice_task_3-articulationText").fill(
      "最困难的是把抽象原则转成学生可执行的步骤；我用具体场景逐项检验和修订。",
    );
    await taskFourCard.getByRole("button", {
      name: "保存前置证据并生成对照报告",
    }).click();

    const reflectionReport = taskFourCard.locator(
      '[data-pilot-reflection-report="practice_task_3"]',
    );
    await expect(reflectionReport).toBeVisible();
    await expect(reflectionReport.locator("[data-expert-step-id]")).toHaveCount(5);
    await expect(reflectionReport.locator(
      '[data-evidence-status="evidence-recorded"]',
    )).not.toHaveCount(0);
    await expect(reflectionReport).toContainText(
      "报告只按字段是否有证据进行确定性比较，不展示你的原文，也不作为聊天发言出现。",
    );
    await expect(taskFourCard.locator("#practice_task_3-reflectionText")).toBeVisible();
    await expect(taskFourCard.locator(
      "#practice_task_3-expertComparisonText",
    )).toBeVisible();

    await taskFourCard.locator("#practice_task_3-reflectionText").fill(
      "与专家过程相比，我需要更早把评价标准写入计划；下次会在生成前建立逐项检查表。",
    );
    await taskFourCard.locator("#practice_task_3-expertComparisonText").fill(
      "专家先把目标转成可观察证据，而我较晚才细化标准，这使前期检查不够聚焦。",
    );
    await taskFourCard.getByRole("button", {
      name: "保存学习证据",
    }).click();
    await expect(taskFourCard.getByText(
      "学习证据已保存，完成门槛已由服务器重新计算。",
      { exact: true },
    )).toBeVisible();
    await expect(taskFourComplete).toBeEnabled();
    await taskFourComplete.click();

    await expect(taskFourCard).toHaveAttribute("data-task-status", "completed");
    await expect(taskFourCard).toHaveAttribute(
      "data-completion-outcome",
      "evidence_complete",
    );
    const summary = taskFourCard.locator(
      '[data-pilot-summary="practice_task_3"]',
    );
    await expect(summary.getByRole("heading", {
      name: "小张 · 总结与结束",
    })).toBeVisible();
    await summary.getByRole("button", {
      name: "确认总结并结束本轮",
    }).click();
    await expect(summary.getByRole("button", {
      name: "本轮总结已确认",
    })).toBeDisabled();

    const session = await readLearningSession(page);
    expectLearnerSessionPrivacyBoundary(session);
    const training = requireTaskSnapshot(session, taskIds.training);
    const taskTwo = requireTaskSnapshot(session, taskIds.taskTwo);
    const taskThree = requireTaskSnapshot(session, taskIds.taskThree);
    const taskFour = requireTaskSnapshot(session, taskIds.taskFour);
    expect(training.status).toBe("completed");
    expect(training.completionOutcome).toBe("evidence_complete");
    expect(training.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "launch_import",
        status: "completed",
      }),
      expect.objectContaining({
        id: "modeling",
        status: "completed",
      }),
    ]));
    expect(taskTwo.status).toBe("completed");
    expect(taskTwo.completionOutcome).toBe("evidence_complete");
    expect(taskTwo.scaffoldRequests).toBe(5);
    expect(taskTwo.scaffoldHistory?.slice(0, 4).map((entry) => entry.level))
      .toEqual([1, 2, 3, 4]);
    expect(taskTwo.scaffoldHistory?.at(-1)).toMatchObject({
      mode: "self-check",
      fading: true,
    });
    expect(taskTwo.scaffoldState).toMatchObject({
      fading: true,
      remainingDirectAssists: 0,
    });
    expect(taskThree.status).toBe("locked");
    expect(taskThree.completionMissing).toContain("pilot_closed");
    expect(taskFour.status).toBe("completed");
    expect(taskFour.completionOutcome).toBe("evidence_complete");
    expect(taskFour.pilotEvidence).toMatchObject({
      aiUseMode: "ai-free",
      outputEvaluation: "ai_free",
      articulationOutcome: "submitted",
      reflectionOutcome: "submitted",
      summaryAcknowledged: true,
    });
    expect(taskFour.reflectionReport).toMatchObject({
      version: "aais-a4-reflection-report-v1",
      basis: "deterministic-field-presence",
      learnerVisibleTurn: false,
      evidenceSummary: {
        rawTextIncluded: false,
      },
    });
    expect(taskFour.reflectionReport?.expertStepIds).toHaveLength(5);
    expect(JSON.stringify(taskFour.reflectionReport)).not.toContain(
      "我先确定指南受众",
    );
    expect(taskFour.activeMilestone).toBe("summary_completion");
    expect(taskFour.milestones?.filter((milestone) =>
      milestone.id === "summary_completion"
    )).toEqual([
      expect.objectContaining({
        id: "summary_completion",
        status: "completed",
      }),
    ]);
    expect(session.guideMessages.flatMap((message) =>
      message.turns?.map((turn) => turn.agentId) ?? []
    )).not.toEqual(expect.arrayContaining(["A3", "A4"]));
    expect(session.events.some((event) =>
      event.event === "deterministic_guide_prompt_submitted"
      || event.event === "deterministic_guide_response_completed"
    )).toBe(false);
    expect(session.events.some((event) =>
      event.event === "ai_prompt_submitted"
      || event.event === "ai_response_completed"
    )).toBe(false);
    expect(guideRouteRequests).toBe(1);

    await page.reload();
    await waitForAaisLearningClientReady(page);
    await openTaskCards(page);
    const reloadedTaskTwo = getTaskCard(page, taskIds.taskTwo);
    const reloadedTaskThree = getTaskCard(page, taskIds.taskThree);
    const reloadedTaskFour = getTaskCard(page, taskIds.taskFour);
    await expect(reloadedTaskTwo).toHaveAttribute("data-task-status", "completed");
    await expect(reloadedTaskThree).toHaveAttribute(
      "data-task-availability",
      "pilot-closed",
    );
    await expect(reloadedTaskFour).toHaveAttribute("data-task-status", "completed");
    await expect(reloadedTaskFour.locator(
      '[data-pilot-reflection-report="practice_task_3"]',
    )).toBeVisible();
    await expect(reloadedTaskFour.getByRole("radio", {
      name: "不使用实时 GenAI",
    })).toBeChecked();
    await expect(reloadedTaskFour.locator(
      '[data-pilot-summary="practice_task_3"]',
    ).getByRole("button", {
      name: "本轮总结已确认",
    })).toBeDisabled();
    const reloadedSession = await readLearningSession(page);
    expectLearnerSessionPrivacyBoundary(reloadedSession);
    const persistedTaskFour = requireTaskSnapshot(reloadedSession, taskIds.taskFour);
    expect(persistedTaskFour.activeMilestone).toBe("summary_completion");
    expect(persistedTaskFour.milestones?.filter((milestone) =>
      milestone.id === "summary_completion"
    )).toEqual([
      expect.objectContaining({
        id: "summary_completion",
        status: "completed",
      }),
    ]);
    expect(reloadedSession.events.some((event) =>
      event.event === "deterministic_guide_prompt_submitted"
      || event.event === "deterministic_guide_response_completed"
    )).toBe(false);
    expect(guideRouteRequests).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(await hasNextErrorOverlay(page)).toBe(false);
  });

  test("recovers from empty and malformed session responses without losing the UI", async ({
    page,
  }) => {
    const studentId = "caasi-pilot-recovery-" + Date.now();
    const serviceUnavailable =
      "学习记录服务暂时不可用，本页会保留当前输入但不会完成持久化。";
    let responseMode: "empty" | "malformed" | "healthy" = "empty";
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("**/api/learning/session", async (route) => {
      if (route.request().method() !== "GET" || responseMode === "healthy") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: responseMode === "empty" ? "" : "{not-valid-json",
      });
    });
    await authenticateAaisE2eActor(page, {
      id: studentId,
      role: "student",
      displayName: "恢复测试学生",
    });

    await page.goto("/learning");
    await waitForAaisLearningClientReady(page);
    await expect(page.getByText(serviceUnavailable, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "平台介绍" })).toBeVisible();

    responseMode = "malformed";
    await page.reload();
    await waitForAaisLearningClientReady(page);
    await expect(page.getByText(serviceUnavailable, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "任务卡片" })).toBeVisible();

    responseMode = "healthy";
    await page.reload();
    await waitForAaisLearningClientReady(page);
    await expect(page.getByText(serviceUnavailable, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "平台介绍" }).click();
    await expect(page.getByRole("heading", {
      name: "从专家示范到独立总结",
    })).toBeVisible();
    await expect(page.locator("[data-pilot-milestone]")).toHaveCount(7);
    expect(pageErrors).toEqual([]);
    expect(await hasNextErrorOverlay(page)).toBe(false);
  });

  test("recovers a failed guide draft, rejects a persisted AI reply, retries, and exits Task 2 incomplete", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const studentId = "caasi-pilot-negative-" + Date.now();
    const garbledPrompt = "%%%%%%";
    const failedPrompt = "请直接给我一份论文大纲，并帮我检查是否符合任务要求。";
    const directAnswerPrompt = "请直接给我完整论文大纲";
    const revisedRetryPrompt =
      "请根据受众、范围、证据标准和篇幅约束重新给出论文大纲建议。";
    const rejectionReason =
      "这条建议只给出笼统结构，没有说明证据来源、受众和评价标准，需要修订。";
    const submittedArticulationText =
      "我先诊断约束缺口，再修订提示词，随后依据证据标准判断是否采纳输出。";
    const incompleteReason = "我先进入开放任务，稍后再补充完整的学习表达。";
    const taskFourGuidePrompt = "@教授 请直接给我完整指南";
    const pageErrors: string[] = [];
    const guideRequestBodies: GuideRequestSnapshot[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/learning/ai-guide", async (route) => {
      const requestBody = readGuideRequestSnapshot(route.request().postData());
      guideRequestBodies.push(requestBody);
      if (requestBody.learnerInput === failedPrompt) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "AAIS_SYNTHETIC_PROVIDER_UNAVAILABLE",
              message: "Synthetic provider failure for local recovery coverage.",
            },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await authenticateAaisE2eActor(page, {
      id: studentId,
      role: "student",
      displayName: "负向流程测试学生",
    });
    await page.goto("/learning");
    await waitForAaisLearningClientReady(page);
    await advanceToTaskTwo(page);

    const guideInput = page.getByLabel("向智能导学输入你的想法");
    const sendGuide = page.getByRole("button", { name: "发送" });
    await guideInput.fill("   ");
    await expect(sendGuide).toBeDisabled();
    expect(guideRequestBodies).toHaveLength(0);
    let unchangedSession = await readLearningSession(page);
    expect(unchangedSession.activeTaskId).toBe(taskIds.taskTwo);
    expect(requireTaskSnapshot(unchangedSession, taskIds.taskTwo).status).toBe("active");
    expect(requireTaskSnapshot(unchangedSession, taskIds.taskFour).status).toBe("locked");

    await guideInput.fill(garbledPrompt);
    const garbledResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/api/learning/ai-guide")) return false;
      try {
        const body = JSON.parse(response.request().postData() ?? "{}") as {
          learnerInput?: string;
        };
        return body.learnerInput === garbledPrompt;
      } catch {
        return false;
      }
    });
    await sendGuide.click();
    const garbledResponse = await garbledResponsePromise;
    const garbledResponseBody = await garbledResponse.json() as {
      error?: { code?: string };
    };
    await expect(page.getByText(
      "智能服务暂时不可用，已保留你的问题。",
      { exact: true },
    )).toBeVisible();
    await expect(guideInput).toHaveValue(garbledPrompt);
    await expect(guideInput).toBeEnabled();
    expect(garbledResponse.status()).toBe(400);
    expect(garbledResponseBody.error?.code).toBe("AAIS_GUIDE_INPUT_UNRECOGNIZABLE");
    unchangedSession = await readLearningSession(page);
    expect(unchangedSession.activeTaskId).toBe(taskIds.taskTwo);
    expect(requireTaskSnapshot(unchangedSession, taskIds.taskTwo).status).toBe("active");
    expect(requireTaskSnapshot(unchangedSession, taskIds.taskFour).status).toBe("locked");
    expect(unchangedSession.guideMessages.some((message) =>
      message.kind === "user" && message.text === garbledPrompt
    )).toBe(false);

    await guideInput.fill(failedPrompt);
    const failedResponsePromise = waitForGuideResponse(page, failedPrompt);
    await sendGuide.click();
    const failedResponse = await failedResponsePromise;
    expect(failedResponse.status()).toBe(503);
    await expect(page.getByText(
      "智能服务暂时不可用，已保留你的问题。",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText(
      "智能服务暂时不可用，已保留你的问题。请稍后重试。",
      { exact: true },
    ).last()).toBeVisible();
    await expect(guideInput).toHaveValue(failedPrompt);
    await expect(guideInput).toBeEnabled();

    const afterFailure = await readLearningSession(page);
    expect(afterFailure.activeTaskId).toBe(taskIds.taskTwo);
    expect(requireTaskSnapshot(afterFailure, taskIds.taskTwo).status).toBe("active");
    expect(requireTaskSnapshot(afterFailure, taskIds.taskFour).status).toBe("locked");
    expect(afterFailure.guideMessages.some((message) =>
      message.kind === "user" && message.text === failedPrompt
    )).toBe(false);

    const assistantCountBeforePersistedReply = await page.locator(
      '[data-guide-message-kind="assistant"]',
    ).count();
    await guideInput.fill(directAnswerPrompt);
    const directAnswerResponsePromise = waitForGuideResponse(page, directAnswerPrompt);
    await sendGuide.click();
    const directAnswerResponse = await directAnswerResponsePromise;
    expect(directAnswerResponse.status()).toBe(200);
    await expect(page.locator('[data-guide-message-kind="assistant"]'))
      .toHaveCount(assistantCountBeforePersistedReply + 1);
    const firstPersistedAssistant = page.locator(
      '[data-guide-message-kind="assistant"]',
    ).last();
    await expect(firstPersistedAssistant).toHaveAttribute(
      "data-guide-message-id",
      /^assistant-[0-9a-f-]{36}$/,
    );
    await expect(guideInput).toBeEnabled();
    await expect(firstPersistedAssistant).not.toContainText("智能服务暂时不可用");
    await expect(firstPersistedAssistant).toContainText(
      "我不会用成品答案替代你的任务",
    );
    const firstCanonicalAssistantId = await firstPersistedAssistant.getAttribute(
      "data-guide-message-id",
    );
    expect(firstCanonicalAssistantId).toMatch(/^assistant-[0-9a-f-]{36}$/);

    const afterPersistedReply = await readLearningSession(page);
    expectLearnerSessionPrivacyBoundary(afterPersistedReply);
    const persistedAssistant = [...afterPersistedReply.guideMessages].reverse().find((message) =>
      message.kind === "assistant" && message.taskId === taskIds.taskTwo
    );
    expect(persistedAssistant?.id).toBe(firstCanonicalAssistantId);
    expect(await readGuideMessageIds(page)).toEqual(
      expect.arrayContaining([firstCanonicalAssistantId]),
    );
    expect(new Set(await readGuideMessageIds(page)).size)
      .toBe((await readGuideMessageIds(page)).length);

    await openTaskCards(page);
    const taskTwoCard = getTaskCard(page, taskIds.taskTwo);
    await taskTwoCard.getByRole("radio", {
      name: "使用 GenAI 辅助",
    }).check();
    await taskTwoCard.locator("#practice_task_1-diagnosisText").fill(
      "原提示词没有界定受众、范围、证据标准和输出结构，因此难以评价质量。",
    );
    await taskTwoCard.locator("#practice_task_1-revisedPromptText").fill(
      revisedRetryPrompt,
    );
    await taskTwoCard.locator("#practice_task_1-outputEvaluationText").fill(
      rejectionReason,
    );
    await taskTwoCard.locator("#practice_task_1-articulationText").fill(
      submittedArticulationText,
    );
    await taskTwoCard.getByRole("radio", {
      name: "不采纳或要求修订，并说明依据",
    }).check();
    const saveEvidence = taskTwoCard.getByRole("button", {
      name: "保存学习证据",
    });
    await saveEvidence.click();
    await expect(taskTwoCard.getByText(
      "学习证据已保存，完成门槛已由服务器重新计算。",
      { exact: true },
    )).toBeVisible();

    const afterRejectedReply = await readLearningSession(page);
    expect(requireTaskSnapshot(afterRejectedReply, taskIds.taskTwo).pilotEvidence)
      .toMatchObject({
        aiUseMode: "ai-supported",
        outputEvaluation: "revision_required",
        outputEvaluationText: rejectionReason,
        articulationOutcome: "submitted",
      });
    expect([...afterRejectedReply.guideMessages].reverse().find((message) =>
      message.kind === "assistant" && message.taskId === taskIds.taskTwo
    )?.id).toBe(firstCanonicalAssistantId);

    await saveEvidence.click();
    await expect(taskTwoCard.getByText(
      "学习证据已保存，完成门槛已由服务器重新计算。",
      { exact: true },
    )).toBeVisible();
    expect((await readGuideMessageIds(page)).filter((id) =>
      id === firstCanonicalAssistantId
    )).toHaveLength(1);

    await guideInput.fill(revisedRetryPrompt);
    const assistantCountBeforeRetry = await page.locator(
      '[data-guide-message-kind="assistant"]',
    ).count();
    await sendGuide.click();
    await expect(page.locator('[data-guide-message-kind="assistant"]'))
      .toHaveCount(assistantCountBeforeRetry + 1);
    const secondPersistedAssistant = page.locator(
      '[data-guide-message-kind="assistant"]',
    ).last();
    await expect(secondPersistedAssistant).toHaveAttribute(
      "data-guide-message-id",
      /^assistant-[0-9a-f-]{36}$/,
    );
    await expect(guideInput).toBeEnabled();
    const secondCanonicalAssistantId = await secondPersistedAssistant.getAttribute(
      "data-guide-message-id",
    );
    expect(secondCanonicalAssistantId).toMatch(/^assistant-[0-9a-f-]{36}$/);
    expect(secondCanonicalAssistantId).not.toBe(firstCanonicalAssistantId);
    const idsAfterRetry = await readGuideMessageIds(page);
    expect(new Set(idsAfterRetry).size).toBe(idsAfterRetry.length);
    const afterRetrySession = await readLearningSession(page);
    expect(afterRetrySession.guideMessages.filter((message) =>
      message.kind === "assistant" && message.taskId === taskIds.taskTwo
    ).map((message) => message.id)).toEqual([
      firstCanonicalAssistantId,
      secondCanonicalAssistantId,
    ]);
    expect(guideRequestBodies).toEqual([
      expect.objectContaining({
        dataGeneration: expect.any(Number),
        learnerInput: garbledPrompt,
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        taskId: taskIds.taskTwo,
        targetAgentIds: ["A1"],
      }),
      expect.objectContaining({
        dataGeneration: expect.any(Number),
        learnerInput: failedPrompt,
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        taskId: taskIds.taskTwo,
        targetAgentIds: ["A1"],
      }),
      expect.objectContaining({
        dataGeneration: expect.any(Number),
        learnerInput: directAnswerPrompt,
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        taskId: taskIds.taskTwo,
        targetAgentIds: ["A1"],
      }),
      expect.objectContaining({
        dataGeneration: expect.any(Number),
        learnerInput: revisedRetryPrompt,
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        taskId: taskIds.taskTwo,
        targetAgentIds: ["A1"],
      }),
    ]);
    expect(guideRequestBodies.every((body) =>
      Number.isSafeInteger(body.dataGeneration)
      && Number(body.dataGeneration) >= 1
    )).toBe(true);
    expect(new Set(guideRequestBodies.map((body) => body.mutationId)).size)
      .toBe(guideRequestBodies.length);

    await page.reload();
    await waitForAaisLearningClientReady(page);
    await openTaskCards(page);
    const reloadedTaskTwo = getTaskCard(page, taskIds.taskTwo);
    await expect(reloadedTaskTwo.locator("#practice_task_1-revisedPromptText"))
      .toHaveValue(revisedRetryPrompt);
    await expect(reloadedTaskTwo.locator("#practice_task_1-outputEvaluationText"))
      .toHaveValue(rejectionReason);
    await expect(reloadedTaskTwo.getByRole("radio", {
      name: "不采纳或要求修订，并说明依据",
    })).toBeChecked();
    await expect(page.locator(
      `[data-guide-message-id="${firstCanonicalAssistantId}"]`,
    )).toHaveCount(1);
    await expect(page.locator(
      `[data-guide-message-id="${secondCanonicalAssistantId}"]`,
    )).toHaveCount(1);
    const reloadedIds = await readGuideMessageIds(page);
    expect(new Set(reloadedIds).size).toBe(reloadedIds.length);
    expect(reloadedIds).toEqual(expect.arrayContaining([
      firstCanonicalAssistantId,
      secondCanonicalAssistantId,
    ]));

    await reloadedTaskTwo.getByRole("button", {
      name: "结束但标记未完成",
    }).click();
    await expect(reloadedTaskTwo.getByText(
      "这会跳过本任务的学习表达并保留缺失项；任务2会标记为未完成，然后继续进入任务4，不会计为达成学习目标。",
      { exact: true },
    )).toBeVisible();
    await reloadedTaskTwo.getByLabel(
      "如愿意，可说明为什么暂不完成本任务的学习表达",
    ).fill(incompleteReason);
    await reloadedTaskTwo.getByRole("button", {
      name: "确认结束并标记未完成",
    }).click();

    const taskThreeCard = getTaskCard(page, taskIds.taskThree);
    const taskFourCard = getTaskCard(page, taskIds.taskFour);
    await expect(reloadedTaskTwo).toHaveAttribute("data-task-status", "completed");
    await expect(reloadedTaskTwo).toHaveAttribute(
      "data-completion-outcome",
      "ended_incomplete",
    );
    await expect(taskThreeCard).toHaveAttribute(
      "data-task-availability",
      "pilot-closed",
    );
    await expect(taskFourCard).toHaveAttribute("data-task-status", "active");

    const finalSession = await readLearningSession(page);
    expectLearnerSessionPrivacyBoundary(finalSession);
    const finalTaskTwo = requireTaskSnapshot(finalSession, taskIds.taskTwo);
    const finalTaskFour = requireTaskSnapshot(finalSession, taskIds.taskFour);
    expect(finalSession.activeTaskId).toBe(taskIds.taskFour);
    expect(finalTaskTwo).toMatchObject({
      status: "completed",
      completionOutcome: "ended_incomplete",
      pilotEvidence: {
        articulationOutcome: "declined",
        articulationDeclineReason: incompleteReason,
        articulationText: submittedArticulationText,
        outputEvaluation: "revision_required",
      },
    });
    expect(finalTaskTwo.completionMissing).toContain("articulate_task_two_process");
    expect(finalTaskFour.activeMilestone).toBe("exploration");
    expect(finalTaskFour.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "exploration", status: "open" }),
    ]));
    expect(finalTaskTwo).not.toHaveProperty("pilotOutcomeAudit");
    expect(finalTaskTwo).not.toHaveProperty("supervisionSignals");

    const assistantCountBeforeTaskFourGuide = await page.locator(
      '[data-guide-message-kind="assistant"]',
    ).count();
    await guideInput.fill(taskFourGuidePrompt);
    const taskFourGuideResponsePromise = waitForGuideResponse(page, taskFourGuidePrompt);
    await sendGuide.click();
    const taskFourGuideResponse = await taskFourGuideResponsePromise;
    expect(taskFourGuideResponse.status()).toBe(200);
    await expect(page.locator('[data-guide-message-kind="assistant"]'))
      .toHaveCount(assistantCountBeforeTaskFourGuide + 1);
    const taskFourAssistant = page.locator(
      '[data-guide-message-kind="assistant"]',
    ).last();
    await expect(taskFourAssistant).toContainText(
      "在当前任务模式下，我不会直接给成品答案",
    );
    expect(guideRequestBodies.at(-1)).toEqual(expect.objectContaining({
      dataGeneration: expect.any(Number),
      learnerInput: taskFourGuidePrompt,
      mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      taskId: taskIds.taskFour,
      targetAgentIds: ["A2"],
    }));
    const afterTaskFourGuide = await readLearningSession(page);
    expectLearnerSessionPrivacyBoundary(afterTaskFourGuide);
    const stillExploringTaskFour = requireTaskSnapshot(
      afterTaskFourGuide,
      taskIds.taskFour,
    );
    expect(afterTaskFourGuide.activeTaskId).toBe(taskIds.taskFour);
    expect(stillExploringTaskFour.activeMilestone).toBe("exploration");
    expect(stillExploringTaskFour.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "exploration", status: "open" }),
    ]));
    expect(pageErrors).toEqual([]);
    expect(await hasNextErrorOverlay(page)).toBe(false);
  });

  test("renders only A1 or A2 turns even if a local response contains A3 and A4 work", async ({
    page,
  }) => {
    const studentId = "caasi-pilot-visible-turns-" + Date.now();
    const guideRequests: Array<{
      dataGeneration?: number;
      learnerInput: string;
      mutationId?: string;
      targetAgentIds: string[];
    }> = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/learning/ai-guide", async (route) => {
      const requestBody = readGuideRequestSnapshot(route.request().postData());
      const targetAgentId = requestBody.targetAgentIds?.[0] === "A2" ? "A2" : "A1";
      guideRequests.push({
        dataGeneration: requestBody.dataGeneration,
        learnerInput: requestBody.learnerInput ?? "",
        mutationId: requestBody.mutationId,
        targetAgentIds: requestBody.targetAgentIds ?? [],
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: { text: "Local synthetic guide response." },
          turns: [
            {
              agentId: targetAgentId,
              label: targetAgentId === "A2" ? "教授" : "小张",
              content: targetAgentId === "A2"
                ? "教授前台本地示范回复。"
                : "小张前台本地导学回复。",
              actions: ["respond"],
            },
            {
              agentId: "A3",
              label: "监督智能体",
              content: "后台监督内容绝不能显示。",
              actions: ["supervise"],
            },
            {
              agentId: "A4",
              label: "反思智能体",
              content: "后台反思内容绝不能显示。",
              actions: ["reflect"],
            },
          ],
          orchestration: {
            graph: {
              graphId: "learning-ai-guide",
              topologicalOrder: [targetAgentId, "A3", "A4"],
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
      id: studentId,
      role: "student",
      displayName: "前台路由测试学生",
    });
    await page.goto("/learning");
    await waitForAaisLearningClientReady(page);

    const guideInput = page.getByLabel("向智能导学输入你的想法");
    await guideInput.fill("请帮我检查当前学习目标");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("小张前台本地导学回复。", {
      exact: true,
    })).toBeVisible();
    await expect(guideInput).toBeEnabled();

    await guideInput.fill("@教授 请示范一个较小的同类步骤");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("教授前台本地示范回复。", {
      exact: true,
    })).toBeVisible();
    await expect(guideInput).toBeEnabled();

    expect(guideRequests).toEqual([
      {
        dataGeneration: expect.any(Number),
        learnerInput: "请帮我检查当前学习目标",
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        targetAgentIds: ["A1"],
      },
      {
        dataGeneration: expect.any(Number),
        learnerInput: "@教授 请示范一个较小的同类步骤",
        mutationId: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        targetAgentIds: ["A2"],
      },
    ]);
    expect(guideRequests.every((body) =>
      Number.isSafeInteger(body.dataGeneration)
      && Number(body.dataGeneration) >= 1
    )).toBe(true);
    expect(new Set(guideRequests.map((body) => body.mutationId)).size)
      .toBe(guideRequests.length);
    await expect(page.getByText("后台监督内容绝不能显示。", {
      exact: true,
    })).toHaveCount(0);
    await expect(page.getByText("后台反思内容绝不能显示。", {
      exact: true,
    })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(await hasNextErrorOverlay(page)).toBe(false);
  });
});

function getTaskCard(page: Page, taskId: string) {
  return page.locator('[data-task-card="' + taskId + '"]');
}

async function openTaskCardsFromArticle(page: Page) {
  await page.getByRole("button", { name: "返回内容展示" }).click();
  await page.getByRole("button", { name: "任务卡片" }).click();
}

async function openTaskCards(page: Page) {
  await page.getByRole("button", { name: "内容展示" }).click();
  await page.getByRole("button", { name: "任务卡片" }).click();
}

function createTaskFourArtifact() {
  return Array.from({ length: 34 }, (_, index) =>
    "第" + (index + 1)
      + "部分：本指南要求大学生先明确学习目标和课程规则，再决定是否使用GenAI；"
      + "使用过程中记录提示词、核查来源、识别偏差与错误，并保留自己的判断、"
      + "修改依据和学术诚信责任。"
  ).join("\n\n");
}

function countVisibleCharacters(value: string) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

type SessionSnapshot = {
  activeTaskId: string;
  guideMessages: Array<{
    id?: string;
    kind?: string;
    taskId?: string;
    text?: string;
    turns?: Array<{ agentId: string }>;
  }>;
  events: Array<{
    event?: string;
    agent?: string;
    task?: string;
    detail?: Record<string, unknown>;
  }>;
  tasks: TaskSnapshot[];
};

type TaskSnapshot = {
  taskId: string;
  activeMilestone?: string;
  status?: string;
  completionOutcome?: string;
  completionMissing?: string[];
  milestones?: Array<{
    id?: string;
    status?: string;
  }>;
  scaffoldRequests?: number;
  scaffoldHistory?: Array<{
    level?: number;
    mode?: string;
    fading?: boolean;
  }>;
  scaffoldState?: {
    fading?: boolean;
    remainingDirectAssists?: number;
  };
  pilotEvidence?: Record<string, unknown>;
  reflectionReport?: {
    version?: string;
    basis?: string;
    expertStepIds?: string[];
    learnerVisibleTurn?: boolean;
    evidenceSummary?: {
      rawTextIncluded?: boolean;
    };
  } | null;
};

type GuideRequestSnapshot = {
  dataGeneration?: number;
  learnerInput?: string;
  mutationId?: string;
  taskId?: string;
  targetAgentIds?: string[];
};

type GuideBudgetSnapshot = {
  limit: number;
  used: number;
  remaining: number;
};

async function readLearningSession(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(async () => {
    const response = await fetch("/api/learning/session", {
      cache: "no-store",
    });
    const body = await response.json() as { session?: SessionSnapshot };
    if (!response.ok || !body.session) {
      throw new Error("The local learner session could not be read.");
    }
    return body.session;
  });
}

function expectLearnerSessionPrivacyBoundary(session: SessionSnapshot) {
  expect(session).not.toHaveProperty("guideCapacityReservations");
  expect(session).not.toHaveProperty("guideMutationReservations");
  for (const task of session.tasks) {
    expect(task).not.toHaveProperty("pilotOutcomeAudit");
    expect(task).not.toHaveProperty("supervisionSignals");
  }
  for (const message of session.guideMessages) {
    expect(message).not.toHaveProperty("guideMutation");
    expect(message).not.toHaveProperty("orchestration");
    for (const turn of message.turns ?? []) {
      expect(["A1", "A2"]).toContain(turn.agentId);
      expect(turn).not.toMatchObject({ actions: expect.arrayContaining(["progress"]) });
    }
  }
  for (const event of session.events) {
    expect(["platform", "A1", "A2"]).toContain(event.agent);
    expect(event.detail).not.toHaveProperty("mutation_key");
    expect(event.detail).not.toHaveProperty("mutation_payload_hash");
    expect(event.detail).not.toHaveProperty("decision_key");
    expect(event.detail).not.toHaveProperty("message_id_hash");
    expect(event.detail).not.toHaveProperty("storage_scope");
  }
  const serialized = JSON.stringify(session);
  expect(serialized).not.toMatch(
    /"(?:guideCapacityReservations|guideMutationReservations|guideMutation|orchestration|pilotOutcomeAudit|supervisionSignals)":/,
  );
  expect(serialized).not.toMatch(/"(?:agent|agentId)":"A[34]"/);
}

function readGuideRequestSnapshot(postData: string | null): GuideRequestSnapshot {
  try {
    return JSON.parse(postData ?? "{}") as GuideRequestSnapshot;
  } catch {
    return {};
  }
}

async function readGuideResponseBudget(response: {
  headers(): Record<string, string>;
  text(): Promise<string>;
}): Promise<GuideBudgetSnapshot> {
  const responseText = await response.text();
  const contentType = response.headers()["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const body = JSON.parse(responseText) as { budget?: GuideBudgetSnapshot };
    if (body.budget) return body.budget;
  } else {
    for (const line of responseText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const body = JSON.parse(line.slice("data:".length).trim()) as {
          budget?: GuideBudgetSnapshot;
        };
        if (body.budget) return body.budget;
      } catch {
        // Ignore non-JSON SSE data and continue to the next event.
      }
    }
  }
  throw new Error("The guide response did not expose a budget snapshot.");
}

function requireTaskSnapshot(session: SessionSnapshot, taskId: string) {
  const task = session.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error("Missing task in learner session: " + taskId);
  }
  return task;
}

async function hasNextErrorOverlay(page: Page) {
  return page.locator("nextjs-portal").evaluateAll((portals) =>
    portals.some((portal) => /Build Error|Runtime Error|Unhandled Runtime Error/i.test(
      portal.shadowRoot?.textContent ?? "",
    ))
  );
}

async function advanceToTaskTwo(page: Page) {
  await page.getByRole("button", { name: "平台介绍" }).click();
  await page.getByRole("button", { name: "我已理解学习流程" }).click();
  await openTaskCardsFromArticle(page);
  const trainingCard = getTaskCard(page, taskIds.training);
  await trainingCard.getByRole("button", {
    name: "我已阅读并比较专家示范",
  }).click();
  await trainingCard.getByRole("button", {
    name: "完成任务：专家示范后的案例训练",
  }).click();
  const taskTwoCard = getTaskCard(page, taskIds.taskTwo);
  await taskTwoCard.getByRole("button", {
    name: "进入任务：社交媒体与大学生心理健康课程论文大纲",
  }).click();
  await expect(page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  })).toBeVisible();
}

async function readGuideMessageIds(page: Page) {
  return page.locator("[data-guide-message-id]").evaluateAll((messages) =>
    messages.map((message) => message.getAttribute("data-guide-message-id") ?? "")
  );
}

function waitForGuideResponse(page: Page, learnerInput: string) {
  return page.waitForResponse((response) => {
    if (!response.url().includes("/api/learning/ai-guide")) return false;
    try {
      const body = JSON.parse(response.request().postData() ?? "{}") as {
        learnerInput?: string;
      };
      return body.learnerInput === learnerInput;
    } catch {
      return false;
    }
  });
}
