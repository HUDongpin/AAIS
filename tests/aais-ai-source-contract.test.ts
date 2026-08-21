import { describe, expect, it } from "vitest";
import {
  createAaisAgentProviderMessages,
  evaluateAaisModelOutput,
  getAaisAiSourceContractEvidence,
} from "@/lib/ai/aais-ai-source-contract";

describe("AAIS AI source contract", () => {
  it("renders practice help and extracted attachment text into the provider contract", () => {
    const messages = createAaisAgentProviderMessages({
      agentId: "A1",
      label: "小张",
      role: "导学智能体",
      mission: "提供逐步支架",
      voice: {
        persona: "清晰的学习伙伴",
        tone: "简洁",
        replyContract: "只推进下一步",
        maxSentences: 3,
        maxCharacters: 240,
        maxOutputTokens: 180,
      },
      caModules: ["Scaffolding", "Fading"],
      locale: "zh-CN",
      phase: "practice",
      taskId: "practice_task_1",
      learnerInput: "我需要再看一步提示",
      conversationHistory: [{ role: "learner", content: "我已经完成了第一步" }],
      workspaceState: {
        currentStep: "practice-step-2",
        artifactText: "已有草稿",
        helpRequestsUsed: 4,
        attachments: [{
          name: "work.txt",
          mediaType: "text/plain",
          sizeBytes: 64,
          extractedText: "附件中的学习证据",
        }],
      },
    });

    expect(messages).toHaveLength(2);
    const payload = JSON.parse(messages[1]!.content);
    expect(payload).toMatchObject({
      agentId: "A1",
      locale: "zh-CN",
      phase: "practice",
      taskId: "practice_task_1",
      conversationHistory: [{ role: "learner", content: "我已经完成了第一步" }],
      workspaceState: {
        currentStep: "practice-step-2",
        artifactCharacters: 4,
        helpRequestsUsed: 4,
        attachments: [{
          name: "work.txt",
          mediaType: "text/plain",
          sizeBytes: 64,
          extractedText: "附件中的学习证据",
        }],
      },
    });
  });

  it("hashes deterministic current A1-A4 prompt, CA, and guardrail evidence", () => {
    const first = getAaisAiSourceContractEvidence();
    const second = getAaisAiSourceContractEvidence();

    expect(second).toEqual(first);
    expect(Object.keys(first.agentPromptContractSha256)).toEqual(["A1", "A2", "A3", "A4"]);
    for (const digest of [
      ...Object.values(first.agentPromptContractSha256),
      first.caBackgroundSha256,
      first.guardrailSha256,
    ]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("binds guardrail evidence to actual pass, length, sentence, and secret outcomes", () => {
    expect(evaluateAaisModelOutput("One concise answer.", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxCharacters: 100,
        maxSentences: 2,
      },
    })).toEqual({
      policy: "aais-age-appropriate-output-v1",
      status: "passed",
      reasons: [],
    });

    expect(evaluateAaisModelOutput("x".repeat(1_800), {})).toMatchObject({
      status: "passed",
      reasons: [],
    });
    expect(evaluateAaisModelOutput("x".repeat(1_801), {})).toMatchObject({
      status: "blocked",
      reasons: ["too-long"],
    });

    expect(evaluateAaisModelOutput("1234", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxCharacters: 4,
      },
    })).toMatchObject({
      status: "passed",
      reasons: [],
    });
    expect(evaluateAaisModelOutput("12345", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxCharacters: 4,
      },
    })).toMatchObject({
      status: "blocked",
      reasons: ["agent-response-too-long"],
    });
    expect(evaluateAaisModelOutput("First. Second!", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxSentences: 2,
      },
    })).toMatchObject({
      status: "passed",
      reasons: [],
    });
    expect(evaluateAaisModelOutput("Only one.", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxSentences: 1,
      },
    })).toMatchObject({
      status: "passed",
      reasons: [],
    });
    expect(evaluateAaisModelOutput("First. Second.", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxSentences: 1,
      },
    })).toMatchObject({
      status: "blocked",
      reasons: ["agent-response-too-many-sentences"],
    });
    expect(evaluateAaisModelOutput("First line\nSecond line", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxSentences: 1,
      },
    })).toMatchObject({
      status: "blocked",
      reasons: ["agent-response-too-many-sentences"],
    });
    expect(evaluateAaisModelOutput("First.\nSecond！Third?", {
      voice: {
        persona: "expert",
        tone: "concise",
        replyContract: "one step",
        maxSentences: 2,
      },
    })).toMatchObject({
      status: "blocked",
      reasons: ["agent-response-too-many-sentences"],
    });
    expect(evaluateAaisModelOutput("Bearer abcdefgh12345678", {})).toMatchObject({
      status: "blocked",
      reasons: ["secret-like-content"],
    });
  });
});
