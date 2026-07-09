import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";

export async function fetchGuideRequest(
  init: RequestInit,
  options: { stream?: boolean } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), guideRequestTimeoutMs);
  try {
    return await fetch("/api/learning/ai-guide", {
      ...init,
      headers: {
        ...(options.stream ? { accept: "text/event-stream" } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function getInitialStudentId() {
  if (typeof window === "undefined") {
    return "S001";
  }
  try {
    const storedStudentId = window.localStorage.getItem("aais_student_id");
    if (storedStudentId) {
      return storedStudentId;
    }
  } catch {
    // Cookie fallback still works when storage is unavailable.
  }
  return readClientCookie("aais_student_id") || "S001";
}

export function getAaisCsrfHeader(): Record<string, string> {
  const token = readClientCookie("aais_csrf");
  return token ? { "x-aais-csrf": token } : {};
}

function readClientCookie(name: string) {
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}
