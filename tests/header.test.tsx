import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Header } from "@/components/layout/header";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

describe("AAIS Header", () => {
  it("exposes the teacher dashboard from the primary navigation", () => {
    render(<Header />);

    const link = screen.getByRole("link", { name: "教师看板" });
    expect(link.getAttribute("href")).toBe("/dashboard");
  });
});
