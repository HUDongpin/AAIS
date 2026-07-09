import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUsersPage } from "@/components/pages/admin-users-page";

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("AdminUsersPage", () => {
  it("loads users and performs invite, role update, and password reset actions", async () => {
    document.cookie = "aais_csrf=csrf-123; path=/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/users" && !init?.method) {
        expect(init?.headers).toMatchObject({
          "x-aais-csrf": "csrf-123",
        });
        return Response.json({
          users: [{
            id: "user-teacher",
            email: "teacher@example.test",
            displayName: "Teacher",
            role: "teacher",
            status: "active",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            lastLoginAt: null,
          }],
          secrets: "redacted",
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-aais-csrf": "csrf-123",
      });
      if (body.action === "invite") {
        return Response.json({
          invite: {
            user: {
              id: "user-new",
              email: body.email,
              displayName: body.displayName,
              role: body.role,
              status: "invited",
              createdAt: "2026-07-09T00:00:00.000Z",
              updatedAt: "2026-07-09T00:00:00.000Z",
              lastLoginAt: null,
            },
            delivery: {
              status: "not_configured",
              provider: "resend",
            },
          },
          secrets: "redacted",
        });
      }
      if (body.action === "update-access") {
        return Response.json({
          user: {
            id: body.userId,
            email: "teacher@example.test",
            displayName: "Teacher",
            role: body.role,
            status: body.status,
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:01:00.000Z",
            lastLoginAt: null,
          },
          secrets: "redacted",
        });
      }
      if (body.action === "password-reset") {
        return Response.json({
          reset: null,
          secrets: "redacted",
        });
      }
      throw new Error(`Unexpected request: ${String(init?.body)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);

    await screen.findByText("teacher@example.test");
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "new@example.test",
      },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: {
        value: "New Teacher",
      },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: {
        value: "teacher",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(screen.queryByText("Invite created.")).not.toBeNull());
    let status = screen.getByRole("status");
    expect(status.textContent).toBe("Invite created.");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(fetchMock.mock.calls.some(([, init]) =>
      String(init?.body).includes("\"action\":\"invite\"")
      && String(init?.body).includes("new@example.test")
    )).toBe(true);

    fireEvent.change(screen.getByLabelText("Role for teacher@example.test"), {
      target: {
        value: "admin",
      },
    });
    fireEvent.change(screen.getByLabelText("Status for teacher@example.test"), {
      target: {
        value: "disabled",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save access for teacher@example.test" }));

    await waitFor(() => expect(screen.queryByText("Access updated.")).not.toBeNull());
    status = screen.getByRole("status");
    expect(status.textContent).toBe("Access updated.");
    expect(fetchMock.mock.calls.some(([, init]) =>
      String(init?.body).includes("\"action\":\"update-access\"")
      && String(init?.body).includes("\"role\":\"admin\"")
      && String(init?.body).includes("\"status\":\"disabled\"")
    )).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reset password for teacher@example.test" }));

    await waitFor(() => expect(screen.queryByText("Password reset request recorded.")).not.toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Password reset request recorded.");
    expect(fetchMock.mock.calls.some(([, init]) =>
      String(init?.body).includes("\"action\":\"password-reset\"")
      && String(init?.body).includes("teacher@example.test")
    )).toBe(true);
  });

  it("announces admin validation errors as alerts", async () => {
    document.cookie = "aais_csrf=csrf-123; path=/";
    const fetchMock = vi.fn(async () => Response.json({
      users: [],
      secrets: "redacted",
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);

    await screen.findByRole("heading", { name: "用户管理" });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Email and display name are required.");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
  });

  it("announces invite progress and blocks duplicate invite submissions", async () => {
    document.cookie = "aais_csrf=csrf-123; path=/";
    const inviteResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/users" && !init?.method) {
        return Response.json({
          users: [],
          secrets: "redacted",
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.action === "invite") {
        return inviteResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.body)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);

    await screen.findByRole("heading", { name: "用户管理" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: {
        value: "new@example.test",
      },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: {
        value: "New Teacher",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    const busyButton = screen.getByRole("button", { name: "Inviting" }) as HTMLButtonElement;
    const form = screen.getByLabelText("Email").closest("form") as HTMLFormElement;
    expect(busyButton.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("main", { name: "用户管理" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Creating invite...");

    fireEvent.submit(form);

    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes("\"action\":\"invite\"")
    )).toHaveLength(1);

    inviteResponse.resolve(Response.json({
      invite: {
        user: {
          id: "user-new",
          email: "new@example.test",
          displayName: "New Teacher",
          role: "student",
          status: "invited",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
          lastLoginAt: null,
        },
        delivery: {
          status: "not_configured",
          provider: "resend",
        },
      },
      secrets: "redacted",
    }));

    await screen.findByText("Invite created.");
    expect(screen.getByRole("main", { name: "用户管理" }).getAttribute("aria-busy")).toBe("false");
  });

  it("announces admin loading and blocks duplicate row actions while requests are pending", async () => {
    document.cookie = "aais_csrf=csrf-123; path=/";
    const usersResponse = createDeferred<Response>();
    const accessResponse = createDeferred<Response>();
    const resetResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/users" && !init?.method) {
        return usersResponse.promise;
      }
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.action === "update-access") {
        return accessResponse.promise;
      }
      if (body.action === "password-reset") {
        return resetResponse.promise;
      }
      throw new Error(`Unexpected request: ${String(init?.body)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminUsersPage />);

    const main = screen.getByRole("main", { name: "用户管理" });
    expect(main.getAttribute("aria-busy")).toBe("true");
    const loadingStatus = screen.getByRole("status");
    expect(loadingStatus.textContent).toBe("Loading accounts");
    expect(loadingStatus.getAttribute("aria-live")).toBe("polite");
    expect(loadingStatus.getAttribute("aria-atomic")).toBe("true");

    usersResponse.resolve(Response.json({
      users: [{
        id: "user-teacher",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
        lastLoginAt: null,
      }],
      secrets: "redacted",
    }));

    await screen.findByText("teacher@example.test");
    expect(main.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Save access for teacher@example.test" }));

    const savingButton = screen.getByRole("button", {
      name: "Saving access for teacher@example.test",
    }) as HTMLButtonElement;
    const resetButton = screen.getByRole("button", {
      name: "Reset password for teacher@example.test",
    }) as HTMLButtonElement;
    expect(savingButton.disabled).toBe(true);
    expect(resetButton.disabled).toBe(true);
    expect((screen.getByLabelText("Role for teacher@example.test") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Status for teacher@example.test") as HTMLSelectElement).disabled).toBe(true);
    expect(main.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Saving access...");

    fireEvent.click(savingButton);
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes("\"action\":\"update-access\"")
    )).toHaveLength(1);

    accessResponse.resolve(Response.json({
      user: {
        id: "user-teacher",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:01:00.000Z",
        lastLoginAt: null,
      },
      secrets: "redacted",
    }));

    await screen.findByText("Access updated.");
    expect(main.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Reset password for teacher@example.test" }));

    const resettingButton = screen.getByRole("button", {
      name: "Resetting password for teacher@example.test",
    }) as HTMLButtonElement;
    expect(resettingButton.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Password reset request in progress.");

    fireEvent.click(resettingButton);
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes("\"action\":\"password-reset\"")
    )).toHaveLength(1);

    resetResponse.resolve(Response.json({
      reset: null,
      secrets: "redacted",
    }));

    await screen.findByText("Password reset request recorded.");
    expect(main.getAttribute("aria-busy")).toBe("false");
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
