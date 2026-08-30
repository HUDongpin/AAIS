import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";

const headersMocks = vi.hoisted(() => ({
  locale: undefined as string | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "aais_locale" && headersMocks.locale
      ? { value: headersMocks.locale }
      : undefined,
  })),
}));

afterEach(() => {
  headersMocks.locale = undefined;
});

describe("AAIS legal notice pages", () => {
  it("renders the Chinese privacy page linked from login", async () => {
    render(await PrivacyPage({}));

    expect(privacyMetadata.title).toBe("Privacy | CAAIS");
    expect(screen.getByRole("heading", { name: "隐私与学习数据说明" })).toBeTruthy();
    expect(screen.getByText(/CSV 字段会进行 spreadsheet-safe escaping/)).toBeTruthy();
    expect(screen.getByText(/未确认时 AAIS 不会签发 session cookie/)).toBeTruthy();
    expect(screen.getAllByText(/\/api\/learning\/privacy/).length).toBeGreaterThan(0);
    expect(screen.getByText(/删除学习数据不会自动删除登录账号/)).toBeTruthy();
    expect(screen.getByText(/真实 cohort 前置条件/)).toBeTruthy();
    expect(screen.getByText(/FERPA、COPPA、GDPR、PIPL/)).toBeTruthy();
    expect(screen.getByText(/小张与教授的互动事件/)).toBeTruthy();
    expect(screen.getByText(/AAIS 不保存附件原始文件或抽取正文/)).toBeTruthy();
    expect(screen.getByText(/成功附件回执元数据/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bA[12]\b/);
    expect(screen.getByRole("link", { name: "返回登录" }).getAttribute("href")).toBe("/login");
  });

  it("renders the Chinese terms page linked from login", async () => {
    render(await TermsPage({}));

    expect(termsMetadata.title).toBe("Terms | CAAIS");
    expect(screen.getByRole("heading", { name: "使用条款" })).toBeTruthy();
    expect(screen.getByText(/小张和教授分别提供学习支架与专家示范/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bA[12]\b/);
    expect(screen.getByText(/不得共享账号、cookie、CSRF token/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回登录" }).getAttribute("href")).toBe("/login");
  });

  it("renders complete English legal copy and preserves English in the back link", async () => {
    render(await PrivacyPage({
      searchParams: Promise.resolve({ lang: "en-US" }),
    }));

    expect(screen.getByRole("heading", { name: "Privacy and learning-data notice" })).toBeTruthy();
    expect(screen.getByText(/AAIS does not retain the original file or extracted text/)).toBeTruthy();
    expect(screen.getByText(/FERPA, COPPA, GDPR, PIPL/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href"))
      .toBe("/login?lang=en-US");
    expect(screen.getByRole("main").getAttribute("lang")).toBe("en-US");
  });

  it("uses the locale cookie for direct legal visits but lets a valid query override it", async () => {
    headersMocks.locale = "en-US";
    const { unmount } = render(await TermsPage({}));

    expect(screen.getByRole("heading", { name: "Terms of Use" })).toBeTruthy();
    expect(screen.getByText(/Xiao Zhang provides learning scaffolds/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href"))
      .toBe("/login?lang=en-US");

    unmount();
    render(await TermsPage({
      searchParams: Promise.resolve({ lang: "zh-CN" }),
    }));
    expect(screen.getByRole("heading", { name: "使用条款" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回登录" }).getAttribute("href"))
      .toBe("/login?lang=zh-CN");
  });
});
