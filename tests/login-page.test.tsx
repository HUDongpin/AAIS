import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dynamic as loginRouteDynamic,
  metadata as loginRouteMetadata,
  default as LoginRoutePage,
} from "@/app/login/page";
import { LoginPage } from "@/components/pages/login-page";
import {
  LoginDesignDeck,
  loginDeckCards,
} from "@/components/pages/login/login-design";

const replace = vi.fn();
const telemetryMocks = vi.hoisted(() => ({
  clear: vi.fn(),
}));
const headersMocks = vi.hoisted(() => ({
  locale: undefined as string | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "aais_locale" && headersMocks.locale
      ? { value: headersMocks.locale }
      : undefined,
  })),
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

describe("login design CSP compatibility", () => {
  it("renders dormant illustration cards without inline style attributes", () => {
    const { container } = render(<LoginDesignDeck cards={loginDeckCards} />);

    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(loginDeckCards.length);
  });

  it("keeps the login illustration payload bounded and eagerly loads only the lead card", async () => {
    const { container } = render(<LoginDesignDeck cards={loginDeckCards} />);
    const sources = loginDeckCards.map((card) => card.assetSrc);
    const sizes = await Promise.all(sources.map(async (source) => {
      const file = await stat(path.join(process.cwd(), "public", source.replace(/^\//, "")));
      return file.size;
    }));

    expect(sources.every((source) => source.endsWith(".webp"))).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(600 * 1024);
    expect(container.querySelectorAll('img[loading="eager"]')).toHaveLength(1);
    expect(container.querySelectorAll('img[loading="lazy"]')).toHaveLength(1);
  });
});

afterEach(() => {
  replace.mockReset();
  telemetryMocks.clear.mockReset();
  headersMocks.locale = undefined;
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "aais_locale=; Max-Age=0; Path=/";
  window.history.replaceState({}, "", "/login");
});

describe("AAIS LoginPage", () => {
  it("warns that a revoked logout with no research ACK must not be marked complete", () => {
    window.history.pushState({}, "", "/login?researchLogout=ack-failed");

    render(<LoginPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "不要将本次实验标记为完成",
    );

    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), {
      target: {
        value: "en-US",
      },
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "do not mark this session complete",
    );
  });
  it("keeps the login route dynamic so runtime auth-mode changes are honored", () => {
    expect(loginRouteDynamic).toBe("force-dynamic");
    expect(loginRouteMetadata).toMatchObject({
      title: "CAAIS",
      description: "Cognitive Apprenticeship AI System",
    });
  });

  it("keeps sign-in consent-gated after client hydration", async () => {
    const { container } = render(<LoginPage />);

    await waitFor(() => {
      expect((container.firstElementChild as HTMLElement).dataset.clientReady).toBe("true");
    });
    const submitButton = screen.getByRole("button", { name: "立即登录" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));

    expect(submitButton.disabled).toBe(false);
  });

  it("switches the login controls between Chinese and English and records the choice", () => {
    const { container } = render(<LoginPage />);

    const languageSelector = screen.getByRole("combobox", { name: "语言" }) as HTMLSelectElement;
    expect(languageSelector.value).toBe("zh-CN");

    fireEvent.change(languageSelector, {
      target: {
        value: "en-US",
      },
    });

    expect(screen.getByRole("heading", { name: "Welcome to CAAIS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account and password" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByLabelText("Account")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).lang).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(window.localStorage.getItem("aais_login_locale")).toBe("en-US");
    expect(document.cookie).toContain("aais_locale=en-US");
    expect(new URL(window.location.href).searchParams.get("lang")).toBe("en-US");
  });

  it("restores a previously selected login language when the URL has no language override", async () => {
    window.localStorage.setItem("aais_login_locale", "en-US");

    const { container } = render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Welcome to CAAIS" })).toBeTruthy();
    });
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveProperty("value", "en-US");
    expect((container.firstElementChild as HTMLElement).lang).toBe("en-US");
  });

  it("hydrates from the server locale cookie before local storage and lets the URL win", async () => {
    headersMocks.locale = "en-US";
    window.localStorage.setItem("aais_login_locale", "zh-CN");

    const { unmount } = render(await LoginRoutePage());

    expect(screen.getByRole("heading", { name: "Welcome to CAAIS" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Terms of Use" }).every(
      (link) => link.getAttribute("href") === "/terms?lang=en-US",
    )).toBe(true);
    expect(screen.getAllByRole("link", { name: "Privacy Policy" }).every(
      (link) => link.getAttribute("href") === "/privacy?lang=en-US",
    )).toBe(true);

    unmount();
    window.history.replaceState({}, "", "/login?lang=zh-CN");
    render(await LoginRoutePage());
    expect(screen.getByRole("heading", { name: "欢迎来到 CAAIS" })).toBeTruthy();
  });

  it("exposes account login and forgot password as working accessible mode controls", async () => {
    render(<LoginPage />);

    const accountLogin = screen.getByRole("button", { name: "账号密码登录" });
    const forgotPassword = screen.getByRole("button", { name: "忘记密码？" });

    expect(accountLogin.getAttribute("aria-pressed")).toBe("true");
    expect(accountLogin.getAttribute("aria-controls")).toBe("aais-account-login-form");
    expect(forgotPassword.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(forgotPassword);

    expect(accountLogin.getAttribute("aria-pressed")).toBe("false");
    expect(forgotPassword.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("账号邮箱")).toBeTruthy();
    expect(screen.queryByLabelText("账号")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("账号邮箱")));

    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("请输入账号邮箱。");
    expect(alert.getAttribute("aria-live")).toBe("assertive");

    fireEvent.click(accountLogin);

    expect(accountLogin.getAttribute("aria-pressed")).toBe("true");
    expect(forgotPassword.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("账号")));
  });

  it("rejects an invalid password-reset email without contacting the server", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
    fireEvent.change(screen.getByLabelText("账号邮箱"), {
      target: {
        value: "invalid-email",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送重置邮件" }));

    expect(screen.getByRole("alert").textContent).toBe("请输入有效的账号邮箱。");
    expect(fetchMock).not.toHaveBeenCalled();
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
      name: "欢迎来到 CAAIS",
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

    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));
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
    const submitButton = screen.getByRole("button", { name: "立即登录" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.className).toContain("disabled:bg-[#a8b8d0]");

    fireEvent.submit(submitButton.closest("form") as HTMLFormElement);

    expect(screen.getByRole("alert").textContent).toBe("请先确认用户协议、隐私政策和必要的监护人同意。");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));
    expect(submitButton.disabled).toBe(false);
  });

  it("localizes login API failures instead of exposing server English", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      error: {
        code: "AAIS_LOGIN_RATE_LIMITED",
        message: "Too many login attempts from the upstream auth service.",
      },
    }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "Phoebe" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));
    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("请求过于频繁，请稍后再试。");
    });
    expect(screen.queryByText(/upstream auth service/i)).toBeNull();
  });

  it("localizes invalid password-link responses in English", async () => {
    window.history.pushState({}, "", "/login#reset_token=aais_reset_test-token-value-1234567890");
    const fetchMock = vi.fn(async () => Response.json({
      error: {
        code: "AAIS_PASSWORD_TOKEN_INVALID",
        message: "AAIS password token invalid.",
      },
    }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage initialLocale="en-US" />);

    await screen.findByLabelText("New password");
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "This password link is invalid or has expired. Request a new one.",
      );
    });
    expect(screen.queryByText("AAIS password token invalid.")).toBeNull();
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
    expect((screen.getByRole("combobox", { name: "语言" }) as HTMLSelectElement).disabled).toBe(true);

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

  it.each([
    {
      name: "204 response",
      createResponse: () => new Response(null, { status: 204 }),
    },
    {
      name: "empty 200 response",
      createResponse: () => new Response(null, { status: 200 }),
    },
    {
      name: "empty object",
      createResponse: () => Response.json({}),
    },
    {
      name: "invalid actor id",
      createResponse: () => Response.json({
        redirectTarget: "/learning",
        appSession: {
          actor: {
            id: "invalid actor id",
            role: "student",
            displayName: "Phoebe",
          },
        },
      }),
    },
    {
      name: "blank actor display name",
      createResponse: () => Response.json({
        redirectTarget: "/learning",
        appSession: {
          actor: {
            id: "Phoebe",
            role: "student",
            displayName: "   ",
          },
        },
      }),
    },
    {
      name: "unsupported actor role",
      createResponse: () => Response.json({
        redirectTarget: "/learning",
        appSession: {
          actor: {
            id: "Phoebe",
            role: "owner",
            displayName: "Phoebe",
          },
        },
      }),
    },
    {
      name: "unsafe redirect target",
      createResponse: () => Response.json({
        redirectTarget: "/\\evil.example/path",
        appSession: {
          actor: {
            id: "Phoebe",
            role: "student",
            displayName: "Phoebe",
          },
        },
      }),
    },
  ])("fails closed on a malformed successful login ACK: $name", async ({ createResponse }) => {
    const storedVisit = JSON.stringify({ visitId: "visit-preserved" });
    const storedQueue = JSON.stringify([{ clientEventId: "event-preserved" }]);
    window.localStorage.setItem("aais_research_visit_v1", storedVisit);
    window.localStorage.setItem("aais_research_event_queue_v1", storedQueue);
    const fetchMock = vi.fn(async () => createResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "Phoebe" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "12345" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /用户协议和隐私政策/ }));
    fireEvent.click(screen.getByRole("button", { name: "立即登录" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("登录服务暂时不可用，请稍后再试。");
    });
    expect(telemetryMocks.clear).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("aais_research_visit_v1")).toBe(storedVisit);
    expect(window.localStorage.getItem("aais_research_event_queue_v1")).toBe(storedQueue);
  });

  it("prevents duplicate invite password saves while the request is pending", async () => {
    window.history.pushState({}, "", "/login?invite_token=aais_invite_test-token-value-1234567890");
    const passwordResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async () => passwordResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    await screen.findByLabelText("新密码");
    expect(window.location.href).not.toContain("invite_token");

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

    passwordResponse.resolve(Response.json(createValidSetPasswordAcknowledgement()));

    await waitFor(() => expect(screen.queryByText("密码已更新，请使用新密码登录。")).not.toBeNull());
  });

  it.each([
    {
      name: "204 response",
      createResponse: () => new Response(null, { status: 204 }),
    },
    {
      name: "empty 200 response",
      createResponse: () => new Response(null, { status: 200 }),
    },
    {
      name: "empty object",
      createResponse: () => Response.json({}),
    },
    {
      name: "incomplete user",
      createResponse: () => Response.json({
        user: {
          id: "user-teacher",
          role: "teacher",
          status: "active",
        },
        secrets: "redacted",
      }),
    },
    {
      name: "malformed user",
      createResponse: () => Response.json({
        ...createValidSetPasswordAcknowledgement(),
        user: {
          ...createValidSetPasswordAcknowledgement().user,
          id: "invalid user id",
        },
      }),
    },
    {
      name: "missing redaction acknowledgement",
      createResponse: () => Response.json({
        ...createValidSetPasswordAcknowledgement(),
        secrets: "available",
      }),
    },
  ])("keeps the password token flow retryable after a malformed 2xx set-password ACK: $name", async ({
    createResponse,
  }) => {
    const token = "aais_invite_test-token-value-1234567890";
    window.history.pushState({}, "", `/login#invite_token=${token}`);
    let requestCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return createResponse();
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "set-password",
        token,
        password: "new-password-123",
      });
      return Response.json(createValidSetPasswordAcknowledgement());
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    const passwordInput = await screen.findByLabelText("新密码") as HTMLInputElement;
    const confirmationInput = screen.getByLabelText("确认密码") as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "new-password-123" } });
    fireEvent.change(confirmationInput, { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存密码" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("登录服务暂时不可用，请稍后再试。");
    });
    expect(passwordInput.value).toBe("new-password-123");
    expect(confirmationInput.value).toBe("new-password-123");
    expect(screen.queryByText("密码已更新，请使用新密码登录。")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存密码" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存密码" }));
    await waitFor(() => expect(screen.queryByText("密码已更新，请使用新密码登录。")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith("/login");
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

    expect(pageRoot.className).toContain("aais-login-serif");
    expect(pageRoot.getAttribute("style")).toBeNull();
    expect(screen.getAllByText("CAAIS")).toHaveLength(1);
    expect(screen.getAllByText("Cognitive Apprenticeship AI System")).toHaveLength(1);
    expect(screen.queryByText("AAIS")).toBeNull();
    expect(screen.queryByText("AAIS 学习端")).toBeNull();
    expect(screen.queryByText("Apprenticeship AI system")).toBeNull();
    expect(screen.queryByText("Learning studio")).toBeNull();
    const welcomeHeading = screen.getByRole("heading", {
      name: "欢迎来到 CAAIS",
    });
    const welcomeHeadingClasses = welcomeHeading.className.split(/\s+/);
    expect(welcomeHeadingClasses).toContain("text-2xl");
    expect(welcomeHeadingClasses).toContain("sm:text-3xl");
    expect(welcomeHeadingClasses).not.toContain("text-3xl");
    expect(welcomeHeadingClasses).not.toContain("sm:text-4xl");
    expect(screen.getAllByText(/Cognitive Apprenticeship/)).toHaveLength(1);
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
    expect(window.localStorage.getItem("aais_student_id")).toBeNull();
    expect(window.localStorage.getItem("aais_display_name")).toBeNull();
  });

  it("sets a database-backed account password from an invite token", async () => {
    window.history.pushState({}, "", "/login#invite_token=aais_invite_test-token-value-1234567890");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input).toBe("/api/auth/password");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "set-password",
        token: "aais_invite_test-token-value-1234567890",
        password: "new-password-123",
      });
      return Response.json(createValidSetPasswordAcknowledgement());
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    await screen.findByLabelText("新密码");
    expect(window.location.href).not.toContain("invite_token");

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
        value: "  teacher@example.test  ",
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

function createValidSetPasswordAcknowledgement() {
  return {
    user: {
      id: "user-teacher",
      email: "teacher@example.test",
      displayName: "Teacher",
      role: "teacher",
      status: "active",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      lastLoginAt: null,
    },
    secrets: "redacted",
  };
}
