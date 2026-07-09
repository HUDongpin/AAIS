"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CheckCircle,
  PaperPlaneTilt,
  ShieldCheck,
  UserGear,
  UsersThree,
} from "@phosphor-icons/react";
import { Header } from "@/components/layout/header";
import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";

type AaisUserRole = "student" | "teacher" | "admin";
type AaisUserStatus = "invited" | "active" | "disabled";

type AaisUserListItem = {
  id: string;
  email: string;
  displayName: string;
  role: AaisUserRole;
  status: AaisUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type AaisUsersResponse = {
  users?: AaisUserListItem[];
  user?: AaisUserListItem;
  invite?: {
    user: AaisUserListItem;
    delivery: {
      status: "sent" | "not_configured";
      provider: "resend";
    };
  };
  reset?: {
    delivery: {
      status: "sent" | "not_configured";
      provider: "resend";
    };
  } | null;
  error?: string | {
    code?: string;
    message?: string;
  };
};

type AccessDraft = {
  role: AaisUserRole;
  status: AaisUserStatus;
};

type ActiveUserAction = {
  userId: string;
  action: "password-reset" | "update-access";
};

const roleLabels: Record<AaisUserRole, string> = {
  student: "Student",
  teacher: "Teacher",
  admin: "Admin",
};

const statusLabels: Record<AaisUserStatus, string> = {
  invited: "Invited",
  active: "Active",
  disabled: "Disabled",
};

export function AdminUsersPage() {
  const [users, setUsers] = useState<AaisUserListItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AccessDraft>>({});
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AaisUserRole>("student");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activeUserAction, setActiveUserAction] = useState<ActiveUserAction | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  const adminBusy = loading || submitting || Boolean(activeUserAction);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      try {
        const response = await fetch("/api/auth/users", {
          credentials: "same-origin",
          headers: getAaisCsrfHeader(),
        });
        const body = (await response.json().catch(() => null)) as AaisUsersResponse | null;
        if (!response.ok || !body?.users) {
          throw new Error(getAaisApiErrorMessage(body, "AAIS user list request failed."));
        }
        if (!cancelled) {
          setUsers(body.users);
          setDrafts(createAccessDrafts(body.users));
          setError("");
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "AAIS user list request failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadUsers();

    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => ({
    total: users.length,
    active: users.filter((user) => user.status === "active").length,
    admins: users.filter((user) => user.role === "admin").length,
  }), [users]);

  async function inviteUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }
    setError("");
    if (!email.trim() || !displayName.trim()) {
      setStatus("");
      setError("Email and display name are required.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setStatus("Creating invite...");
    try {
      const body = await postUserAction({
        action: "invite",
        email,
        displayName,
        role,
      });
      if (!body.invite?.user) {
        throw new Error("AAIS invite request failed.");
      }
      upsertUser(body.invite.user);
      setDrafts((current) => ({
        ...current,
        [body.invite!.user.id]: {
          role: body.invite!.user.role,
          status: body.invite!.user.status,
        },
      }));
      setEmail("");
      setDisplayName("");
      setRole("student");
      setStatus(body.invite.delivery.status === "sent" ? "Invite sent." : "Invite created.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AAIS invite request failed.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function resetPassword(user: AaisUserListItem) {
    if (activeUserAction) {
      return;
    }
    setError("");
    setStatus("Password reset request in progress.");
    setActiveUserAction({
      userId: user.id,
      action: "password-reset",
    });
    try {
      await postUserAction({
        action: "password-reset",
        email: user.email,
      });
      setStatus("Password reset request recorded.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AAIS password reset request failed.");
    } finally {
      setActiveUserAction(null);
    }
  }

  async function updateAccess(user: AaisUserListItem) {
    if (activeUserAction) {
      return;
    }
    const draft = drafts[user.id];
    if (!draft) {
      return;
    }
    setError("");
    setStatus("Saving access...");
    setActiveUserAction({
      userId: user.id,
      action: "update-access",
    });
    try {
      const body = await postUserAction({
        action: "update-access",
        userId: user.id,
        role: draft.role,
        status: draft.status,
      });
      if (!body.user) {
        throw new Error("AAIS user access update failed.");
      }
      upsertUser(body.user);
      setStatus("Access updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AAIS user access update failed.");
    } finally {
      setActiveUserAction(null);
    }
  }

  async function postUserAction(body: Record<string, unknown>) {
    const response = await fetch("/api/auth/users", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...getAaisCsrfHeader(),
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => null)) as AaisUsersResponse | null;
    if (!response.ok) {
      throw new Error(getAaisApiErrorMessage(result, "AAIS user management request failed."));
    }
    return result ?? {};
  }

  function upsertUser(user: AaisUserListItem) {
    setUsers((current) => [
      user,
      ...current.filter((candidate) => candidate.id !== user.id),
    ]);
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main
        className="mx-auto grid w-full max-w-[1280px] gap-5 px-3 py-6 sm:px-4 lg:px-5 2xl:px-6"
        aria-labelledby="aais-admin-users-heading"
        aria-busy={adminBusy}
      >
        <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#1f6feb]">Account administration</p>
              <h1 id="aais-admin-users-heading" className="mt-1 text-3xl font-black tracking-normal text-[#171b35]">用户管理</h1>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm font-bold text-[#3f4b69]">
              <MetricPill icon={UsersThree} label="Total" value={counts.total} />
              <MetricPill icon={CheckCircle} label="Active" value={counts.active} />
              <MetricPill icon={ShieldCheck} label="Admins" value={counts.admins} />
            </div>
          </div>

          {error ? (
            <p
              className="mt-5 rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
            >
              {error}
            </p>
          ) : null}
          {status ? (
            <p
              className="mt-5 rounded-lg border border-[#9bd8b2] bg-[#ecfff3] px-4 py-3 text-sm font-semibold text-[#166534]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {status}
            </p>
          ) : null}

          <form
            onSubmit={inviteUser}
            className="mt-5 grid gap-3 rounded-xl border border-[#dfe7f6] bg-[#fbfdff] p-3 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,0.8fr)_160px_auto]"
            noValidate
            aria-busy={submitting}
          >
            <label className="grid gap-1 text-xs font-bold uppercase text-[#68708a]" htmlFor="aais-admin-invite-email">
              Email
              <input
                id="aais-admin-invite-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-11 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-semibold normal-case text-[#202640] outline-none transition focus:border-[#1f6feb] focus:ring-2 focus:ring-[#1f6feb]/20"
                autoComplete="email"
                type="email"
              />
            </label>
            <label className="grid gap-1 text-xs font-bold uppercase text-[#68708a]" htmlFor="aais-admin-invite-name">
              Display name
              <input
                id="aais-admin-invite-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="h-11 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-semibold normal-case text-[#202640] outline-none transition focus:border-[#1f6feb] focus:ring-2 focus:ring-[#1f6feb]/20"
              />
            </label>
            <label className="grid gap-1 text-xs font-bold uppercase text-[#68708a]" htmlFor="aais-admin-invite-role">
              Role
              <select
                id="aais-admin-invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as AaisUserRole)}
                className="h-11 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-semibold normal-case text-[#202640] outline-none transition focus:border-[#1f6feb] focus:ring-2 focus:ring-[#1f6feb]/20"
              >
                {Object.entries(roleLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#1f6feb] px-4 text-sm font-bold text-white outline-none transition hover:bg-[#1557c0] focus-visible:ring-2 focus-visible:ring-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-70"
            >
              <PaperPlaneTilt size={16} weight="duotone" />
              {submitting ? "Inviting" : "Invite"}
            </button>
          </form>
        </section>

        <section
          className="rounded-2xl border border-[#dfe7f6] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)]"
          aria-busy={loading || Boolean(activeUserAction)}
        >
          <div className="border-b border-[#e9ecf4] px-5 py-4">
            <h2 className="text-lg font-black text-[#171b35]">Accounts</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#e9ecf4] bg-[#f8fbff] text-xs uppercase text-[#68708a]">
                  <th className="px-5 py-3 font-bold">User</th>
                  <th className="px-4 py-3 font-bold">Role</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Last login</th>
                  <th className="px-5 py-3 font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.length ? users.map((user) => {
                  const draft = drafts[user.id] ?? { role: user.role, status: user.status };
                  const savingAccess =
                    activeUserAction?.userId === user.id
                    && activeUserAction.action === "update-access";
                  const resettingPassword =
                    activeUserAction?.userId === user.id
                    && activeUserAction.action === "password-reset";
                  const rowBusy = Boolean(activeUserAction);
                  return (
                    <tr key={user.id} className="border-b border-[#eef2f8] last:border-b-0">
                      <td className="px-5 py-4">
                        <p className="font-bold text-[#222842]">{user.displayName}</p>
                        <p className="mt-1 text-xs font-semibold text-[#68708a]">{user.email}</p>
                      </td>
                      <td className="px-4 py-4">
                        <select
                          aria-label={`Role for ${user.email}`}
                          value={draft.role}
                          disabled={rowBusy}
                          onChange={(event) => setDrafts((current) => ({
                            ...current,
                            [user.id]: {
                              ...draft,
                              role: event.target.value as AaisUserRole,
                            },
                          }))}
                          className="h-10 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-bold text-[#202640] outline-none transition focus:border-[#1f6feb] focus:ring-2 focus:ring-[#1f6feb]/20 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {Object.entries(roleLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-4">
                        <select
                          aria-label={`Status for ${user.email}`}
                          value={draft.status}
                          disabled={rowBusy}
                          onChange={(event) => setDrafts((current) => ({
                            ...current,
                            [user.id]: {
                              ...draft,
                              status: event.target.value as AaisUserStatus,
                            },
                          }))}
                          className="h-10 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-bold text-[#202640] outline-none transition focus:border-[#1f6feb] focus:ring-2 focus:ring-[#1f6feb]/20 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {Object.entries(statusLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        {user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void updateAccess(user)}
                            disabled={rowBusy}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-70"
                            aria-label={savingAccess ? `Saving access for ${user.email}` : `Save access for ${user.email}`}
                          >
                            <UserGear size={16} weight="duotone" />
                            {savingAccess ? "Saving" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void resetPassword(user)}
                            disabled={rowBusy}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-70"
                            aria-label={resettingPassword ? `Resetting password for ${user.email}` : `Reset password for ${user.email}`}
                          >
                            <ShieldCheck size={16} weight="duotone" />
                            {resettingPassword ? "Resetting" : "Reset"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td className="px-5 py-8 text-sm font-semibold text-[#68708a]" colSpan={5}>
                      {loading ? (
                        <span role="status" aria-live="polite" aria-atomic="true">
                          Loading accounts
                        </span>
                      ) : "No accounts"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetricPill({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersThree;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d8e6fb] bg-[#f8fbff] px-3">
      <Icon size={17} weight="duotone" className="text-[#1f6feb]" />
      {label} {value}
    </span>
  );
}

function createAccessDrafts(users: AaisUserListItem[]) {
  return Object.fromEntries(users.map((user) => [
    user.id,
    {
      role: user.role,
      status: user.status,
    },
  ]));
}

function getAaisCsrfHeader(): Record<string, string> {
  const token = readCookie("aais_csrf");
  return token ? { "x-aais-csrf": token } : {};
}

function readCookie(name: string) {
  if (typeof document === "undefined") {
    return "";
  }
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
