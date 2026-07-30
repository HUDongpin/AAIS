import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dynamic as loginRouteDynamic,
  metadata as loginRouteMetadata,
} from "@/app/login/page";
import { LoginPage } from "@/components/pages/login-page";

const replace = vi.fn();
const telemetryMocks = vi.hoisted(() => ({
  clear: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    fill,
    priority,
    unoptimized,
    ...props
  }: {
    src: string;
    alt: string;
    fill?: boolean;
    priority?: boolean;
    unoptimized?: boolean;
  }) => {
    void fill;
    void priority;
    void unoptimized;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...props} />;
  },
}));

vi.mock("@/lib/client/aais-research-telemetry", () => ({
  clearAaisResearchTelemetryForActor: telemetryMocks.clear,
}));

afterEach(() => {
  replace.mockReset();
  telemetryMocks.clear.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/login");
});

describe("AAIS LoginPage", () => {
  it("warns that a revoked logout with no research ACK must not be marked complete", () => {
    window.history.pushState({}, "", "/login?researchLogout=ack-failed");

    render(<LoginPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "不要将本次实验标记为完成",
    );
  });
  it("keeps the login route dynamic so runtime auth-mode changes are honored", () => {
    expect(loginRouteDynamic).toBe("force-dynamic");
    expect(loginRouteMetadata).toMatchObject({
      title: "CAAIS",
      description: "Cognitive Apprenticeship AI System",
    });
  });

  it("temporarily hides the enterprise SSO entry", () => {
    window.history.pushState({}, "", "/login?from=/learning");

    render(<LoginPage />);

    expect(screen.queryByRole("link", { name: "使用机构 SSO 登录" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "用户协议" }).every((link) => link.getAttribute("href") === "/terms"))
      .toBe(true);
    expect(screen.getAllByRole("link", { name: "隐私政策" }).every((link) => link.getAttribute("href") === "/privacy"))
      .toBe(true);
  });

  it("keeps database account login available when trial login is disabled", () => {
    const { container } = render(<LoginPage trialLoginEnabled={false} />);

    expect(screen.getByRole("main", {
      name: "欢迎来到 CAAIS：专注 Cognitive Apprenticeship 的智能学习平台",
    })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "使用机构 SSO 登录" })).toBeNull();
    expect((container.firstElementChild as HTMLElement).dataset.trialLogin).toBe("disabled");
    expect(screen.getByLabelText("账号")).not.toBeNull();
    expect(screen.getByLabelText("密码")).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "立即登录" })).not.toBeNull();
  });

  it("announces login validation errors to assistive technology", () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("请输入账号和密码。");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
  });

  it("requires explicit terms, privacy, and guardian-consent acknowledgement before login", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: {
        value: "Phoebe",
      },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: {
        value: "12345",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    expect(screen.getByRole("alert").textContent).toBe("请先确认用户协议、隐私政策和必要的监护人同意。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the login form busy and disables submit while authentication is pending", async () => {
    const authResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async () => authResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: {
        value: "Phoebe",
      },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: {
        value: "12345",
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));
    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    const busyButton = screen.getByRole("button", { name: "登录中..." }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(screen.getByLabelText("账号").closest("form")?.getAttribute("aria-busy")).toBe("true");

    authResponse.resolve(Response.json({
      redirectTarget: "/learning",
      appSession: {
        actor: {
          id: "Phoebe",
          role: "student",
          displayName: "Phoebe",
        },
      },
    }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/learning"));
    expect(telemetryMocks.clear).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate invite password saves while the request is pending", async () => {
    window.history.pushState({}, "", "/login?invite_token=aais_invite_test-token-value-1234567890");
    const passwordResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async () => passwordResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("新密码"), {
      target: {
        value: "new-password-123",
      },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: {
        value: "new-password-123",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存密码" }));

    const busyButton = screen.getByRole("button", { name: "保存中..." }) as HTMLButtonElement;
    const form = screen.getByLabelText("新密码").closest("form") as HTMLFormElement;
    expect(busyButton.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    passwordResponse.resolve(Response.json({
      user: {
        id: "user-teacher",
        role: "teacher",
        status: "active",
      },
    }));

    await waitFor(() => expect(screen.queryByText("密码已更新，请使用新密码登录。")).not.toBeNull());
  });

  it("prevents duplicate password reset requests while delivery is pending", async () => {
    window.history.pushState({}, "", "/login");
    const resetResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async () => resetResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    fireEvent.change(screen.getByLabelText("账号邮箱"), {
      target: {
        value: "teacher@example.test",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));

    const busyButton = screen.getByRole("button", { name: "发送中..." }) as HTMLButtonElement;
    const form = screen.getByLabelText("账号邮箱").closest("form") as HTMLFormElement;
    expect(busyButton.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetResponse.resolve(Response.json({
      ok: true,
      delivery: "queued_if_account_exists",
    }));

    await waitFor(() => {
      expect(screen.queryByText("如果该账号存在，重置邮件将会发送到对应邮箱。")).not.toBeNull();
    });
  });

  it("renders the CAAIS login with Anthropic Serif typography and redirects students to My Learning", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        account: "Phoebe",
        password: "12345",
        consentAccepted: true,
      });
      return (
        Response.json({
          redirectTarget: "/learning",
          appSession: {
            actor: {
              id: "Phoebe",
              role: "student",
              displayName: "Phoebe",
            },
          },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<LoginPage />);
    const pageRoot = container.firstElementChild as HTMLElement;

    expect(pageRoot.style.fontFamily).toContain("Anthropic Serif");
    expect(pageRoot.style.fontFamily).toContain("Georgia");
    expect(screen.getAllByText("CAAIS")).toHaveLength(2);
    expect(screen.getAllByText("Cognitive Apprenticeship AI System")).toHaveLength(2);
    expect(screen.queryByText("AAIS")).toBeNull();
    expect(screen.queryByText("AAIS 学习端")).toBeNull();
    expect(screen.queryByText("Apprenticeship AI system")).toBeNull();
    expect(screen.queryByText("Learning studio")).toBeNull();
    const welcomeHeading = screen.getByRole("heading", {
      name: "欢迎来到 CAAIS：专注 Cognitive Apprenticeship 的智能学习平台",
    });
    const welcomeHeadingClasses = welcomeHeading.className.split(/\s+/);
    expect(welcomeHeadingClasses).toContain("text-2xl");
    expect(welcomeHeadingClasses).toContain("sm:text-3xl");
    expect(welcomeHeadingClasses).not.toContain("text-3xl");
    expect(welcomeHeadingClasses).not.toContain("sm:text-4xl");
    expect(screen.getAllByText(/Cognitive Apprenticeship/)).toHaveLength(3);
    expect(screen.queryByText("我的教学")).toBeNull();
    expect(screen.queryByText("课程广场")).toBeNull();
    const consentCheckbox = screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }) as HTMLInputElement;
    expect(consentCheckbox.checked).toBe(false);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: {
        value: "Phoebe",
      },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: {
        value: "12345",
      },
    });
    fireEvent.click(consentCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/learning"));
    expect(window.localStorage.getItem("aais_student_id")).toBe("Phoebe");
  });

  it("sets a database-backed account password from an invite token", async () => {
    window.history.pushState({}, "", "/login?invite_token=aais_invite_test-token-value-1234567890");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input).toBe("/api/auth/password");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "set-password",
        token: "aais_invite_test-token-value-1234567890",
        password: "new-password-123",
      });
      return Response.json({
        user: {
          id: "user-teacher",
          email: "teacher@example.test",
          displayName: "Teacher",
          role: "teacher",
          status: "active",
        },
        secrets: "redacted",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("新密码"), {
      target: {
        value: "new-password-123",
      },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: {
        value: "new-password-123",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存密码" }));

    await waitFor(() => expect(screen.queryByText("密码已更新，请使用新密码登录。")).not.toBeNull());
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("密码已更新，请使用新密码登录。");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(replace).toHaveBeenCalledWith("/login");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("teacher@example.test");
  });

  it("requests a password reset without exposing whether the account exists", async () => {
    window.history.pushState({}, "", "/login");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input).toBe("/api/auth/password");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "request-reset",
        email: "teacher@example.test",
      });
      return Response.json({
        ok: true,
        delivery: "queued_if_account_exists",
        secrets: "redacted",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    fireEvent.change(screen.getByLabelText("账号邮箱"), {
      target: {
        value: "teacher@example.test",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));

    await waitFor(() => expect(screen.queryByText("如果该账号存在，重置邮件将会发送到对应邮箱。")).not.toBeNull());
    expect(screen.getByRole("status").textContent).toBe("如果该账号存在，重置邮件将会发送到对应邮箱。");
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    reject,
    resolve,
  };
}
