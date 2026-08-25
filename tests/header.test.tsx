import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/layout/header";

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("@/lib/client/aais-browser-navigation", () => ({
  replaceAaisBrowserLocation: navigationMocks.replace,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  navigationMocks.replace.mockClear();
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("AAIS Header", () => {
  it("exposes the teacher dashboard from the primary navigation", () => {
    render(<Header />);

    const link = screen.getByRole("link", { name: "教师看板" });
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  it("revokes the app session before navigating and blocks duplicate logout clicks", async () => {
    document.cookie = "aais_csrf=csrf-header-logout; path=/";
    const logoutResponse = createDeferred<Response>();
    const fetchMock = vi.fn(() => logoutResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<Header />);

    const logoutButton = screen.getByRole("button", { name: "退出账号" }) as HTMLButtonElement;
    expect(logoutButton.className).toContain("min-h-11");
    expect(logoutButton.className).toContain("min-w-11");
    fireEvent.click(logoutButton);

    const busyButton = screen.getByRole("button", { name: "正在退出账号" }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("正在退出账号");
    fireEvent.click(busyButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/app-session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        "x-aais-csrf": "csrf-header-logout",
      },
    });
    expect(navigationMocks.replace).not.toHaveBeenCalled();

    logoutResponse.resolve(Response.json({
      ok: true,
      sessionAbsent: false,
      sessionRevoked: true,
      secrets: "redacted",
    }));

    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledWith("/login"));
  });

  it("keeps the current page active and focuses an announced error when revocation fails", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      error: {
        code: "AAIS_LOGOUT_FAILED",
        message: "AAIS server session revocation failed; the session remains active.",
      },
      secrets: "redacted",
    }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: "退出账号" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("退出失败，会话仍然有效。请稍后重试。");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    expect(document.activeElement).toBe(alert);
    expect(navigationMocks.replace).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "退出账号" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("treats an already absent server session as an idempotent logout success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      sessionAbsent: true,
      sessionRevoked: false,
      secrets: "redacted",
    })));

    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: "退出账号" }));

    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("localizes the shared header for an English session", () => {
    render(<Header locale="en-US" />);

    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "My learning" }).getAttribute("href")).toBe("/learning");
    expect(screen.getByRole("link", { name: "Teacher dashboard" }).getAttribute("href")).toBe("/dashboard");
    expect(screen.getByRole("button", { name: "User" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("banner").getAttribute("lang")).toBe("en-US");
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
