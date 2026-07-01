import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamic as loginRouteDynamic } from "@/app/login/page";
import { LoginPage } from "@/components/pages/login-page";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
  }),
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

afterEach(() => {
  replace.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AAIS LoginPage", () => {
  it("keeps the login route dynamic so runtime auth-mode changes are honored", () => {
    expect(loginRouteDynamic).toBe("force-dynamic");
  });

  it("offers an enterprise SSO entry that preserves the return target", () => {
    window.history.pushState({}, "", "/login?from=/learning");

    render(<LoginPage />);

    expect(screen.getByRole("link", { name: "使用机构 SSO 登录" }).getAttribute("href")).toBe(
      "/api/auth/oidc/start?from=%2Flearning",
    );
    expect(screen.getByRole("link", { name: "用户协议" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "隐私政策" }).getAttribute("href")).toBe("/privacy");
  });

  it("hides the trial account form when trial login is disabled", () => {
    render(<LoginPage trialLoginEnabled={false} />);

    expect(screen.getByRole("link", { name: "使用机构 SSO 登录" })).toBeTruthy();
    expect(screen.queryByLabelText("账号")).toBeNull();
    expect(screen.queryByLabelText("密码")).toBeNull();
    expect(screen.queryByRole("button", { name: "立即登录" })).toBeNull();
  });

  it("renders the UAIS-style AAIS login and redirects students to My Learning", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        account: "Phoebe",
        password: "12345",
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

    render(<LoginPage />);

    expect(screen.getByText("AAIS")).toBeTruthy();
    expect(screen.getByText("Apprenticeship AI system")).toBeTruthy();
    expect(screen.getByText(/Cognitive Apprenticeship/)).toBeTruthy();
    expect(screen.queryByText("我的教学")).toBeNull();
    expect(screen.queryByText("课程广场")).toBeNull();

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

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/learning"));
    expect(window.localStorage.getItem("aais_student_id")).toBe("Phoebe");
  });
});
