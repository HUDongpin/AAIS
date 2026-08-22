import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { LearningTopBar } from "@/components/pages/learning/learning-top-bar";

function renderContentEditorPanel() {
  return render(
    <ContentSidePanel
      activeContentId={null}
      activeTab="editor"
      artifactSaveBusy={false}
      artifactSaveError=""
      artifactSaveStatus=""
      artifactText=""
      documentDownloadBusy={false}
      documentDownloadError=""
      documentDownloadStatus=""
      documentTitle=""
      flushPendingArtifactSave={() => undefined}
      historyDocuments={[]}
      onBackContent={() => undefined}
      onDocumentTitleChange={() => undefined}
      onDownloadDocument={() => undefined}
      onOpenContent={() => undefined}
      onOpenDocument={() => undefined}
      onRecordArtifact={() => undefined}
      onSaveAndCloseDocument={() => undefined}
      selectContentTab={() => undefined}
    />,
  );
}

function ControlledTopBar({
  displayName = "Bobie",
  locale = "zh-CN",
  onDeleteLearnerData = () => undefined,
  onExportLearnerData = () => undefined,
  onLogout = () => undefined,
}: {
  displayName?: string;
  locale?: "zh-CN" | "en-US";
  onDeleteLearnerData?: () => void | Promise<void>;
  onExportLearnerData?: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  return (
    <>
      <LearningTopBar
        accountMenuOpen={accountMenuOpen}
        displayName={displayName}
        loggingOut={false}
        locale={locale}
        privacyBusy={false}
        onDeleteLearnerData={onDeleteLearnerData}
        onExportLearnerData={onExportLearnerData}
        onLogout={onLogout}
        onToggleAccountMenu={() => setAccountMenuOpen((open) => !open)}
      />
      <button type="button">菜单外按钮</button>
    </>
  );
}

describe("learning responsive controls", () => {
  it("uses a two-column mobile editor action grid without changing the desktop flex widths", () => {
    renderContentEditorPanel();

    const controls = [
      screen.getByRole("button", { name: "内容展示" }),
      screen.getByRole("button", { name: "文档编辑" }),
      screen.getByRole("button", { name: "保存并关闭" }),
      screen.getByRole("button", { name: "下载到本地" }),
    ];
    const actionBar = controls[0].parentElement;

    expect(actionBar?.className).toContain("grid-cols-2");
    expect(actionBar?.className).toContain("lg:flex");
    expect(actionBar?.className).toContain("lg:h-14");
    controls.forEach((control) => {
      expect(control.className).toContain("min-w-0");
      expect(control.className).toContain("h-14");
    });
    expect(controls[0].className).toContain("lg:min-w-[148px]");
    expect(controls[1].className).toContain("lg:min-w-[148px]");
    expect(controls[2].className).toContain("lg:min-w-[104px]");
    expect(controls[3].className).toContain("lg:min-w-[104px]");
    expect(controls[3].className).toContain("lg:ml-auto");
  });
});

describe("LearningTopBar account menu", () => {
  it.each([
    { locale: "zh-CN" as const, displayName: "学习者".repeat(40), suffix: "账户菜单" },
    { locale: "en-US" as const, displayName: "L".repeat(120), suffix: "account menu" },
  ])("bounds and truncates a legal 120-character $locale name without weakening keyboard or touch behavior", async ({
    displayName,
    locale,
    suffix,
  }) => {
    const { container } = render(
      <ControlledTopBar displayName={displayName} locale={locale} />,
    );
    const trigger = screen.getByRole("button", { name: `${displayName} ${suffix}` });
    const accountRoot = container.querySelector('[data-account-root="true"]');
    const name = container.querySelector('[data-account-display-name="true"]');
    const brand = trigger.closest("header")?.firstElementChild;

    expect(displayName).toHaveLength(120);
    expect(brand?.className).toContain("flex-1");
    expect(accountRoot?.className).toContain("min-w-0");
    expect(accountRoot?.className).toContain("max-w-[50%]");
    expect(accountRoot?.className).toContain("shrink");
    expect(accountRoot?.className).not.toContain("shrink-0");
    expect(trigger.className).toContain("min-h-11");
    expect(trigger.className).toContain("min-w-11");
    expect(trigger.className).toContain("max-w-full");
    expect(name?.className).toContain("min-w-0");
    expect(name?.className).toContain("truncate");
    expect(name?.getAttribute("title")).toBe(displayName);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const firstItem = (await screen.findAllByRole("menuitem"))[0];
    await waitFor(() => expect(document.activeElement).toBe(firstItem));
  });

  it("opens from the trigger into the first or last item and loops through the menu keys", async () => {
    render(<ControlledTopBar />);
    const trigger = screen.getByRole("button", { name: "Bobie 账户菜单" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[2]));

    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "End" });
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(items[2], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const reopenedItems = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(reopenedItems[0]));
  });

  it("closes once when pointer and focus leave the menu boundary", async () => {
    const onToggleAccountMenu = vi.fn();
    render(
      <>
        <LearningTopBar
          accountMenuOpen
          displayName="Bobie"
          loggingOut={false}
          privacyBusy={false}
          onDeleteLearnerData={() => undefined}
          onExportLearnerData={() => undefined}
          onLogout={() => undefined}
          onToggleAccountMenu={onToggleAccountMenu}
        />
        <button type="button">菜单外按钮</button>
      </>,
    );
    const outside = screen.getByRole("button", { name: "菜单外按钮" });

    fireEvent.pointerDown(outside);
    outside.focus();

    expect(onToggleAccountMenu).toHaveBeenCalledTimes(1);
  });

  it("closes when keyboard focus moves outside the controlled menu", async () => {
    render(<ControlledTopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    await screen.findByRole("menu");

    screen.getByRole("button", { name: "菜单外按钮" }).focus();

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps every target at least 44px high and blocks duplicate dispatch while real async work is pending", async () => {
    const exportCompletion = createDeferred<void>();
    const onExportLearnerData = vi.fn(() => exportCompletion.promise);
    render(<ControlledTopBar onExportLearnerData={onExportLearnerData} />);
    const trigger = screen.getByRole("button", { name: "Bobie 账户菜单" });
    expect(trigger.className).toContain("min-h-11");
    expect(trigger.className).toContain("min-w-11");

    fireEvent.click(trigger);
    const items = await screen.findAllByRole("menuitem");
    items.forEach((item) => {
      expect(item.className).toContain("min-h-11");
      expect(item.tabIndex).toBe(-1);
    });

    fireEvent.click(items[0]);
    fireEvent.click(items[0]);
    expect(onExportLearnerData).toHaveBeenCalledTimes(1);

    exportCompletion.resolve();
    await waitFor(() => {
      fireEvent.click(items[0]);
      expect(onExportLearnerData).toHaveBeenCalledTimes(2);
    });
  });

  it("releases a refused synchronous action so the same open menu can retry", async () => {
    const acceptedCompletion = createDeferred<void>();
    let ready = false;
    const onDeleteLearnerData = vi.fn(() => {
      if (!ready) {
        return;
      }
      return acceptedCompletion.promise;
    });
    render(<ControlledTopBar onDeleteLearnerData={onDeleteLearnerData} />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "删除学习数据" });

    fireEvent.click(deleteItem);
    expect(onDeleteLearnerData).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeTruthy();

    ready = true;
    fireEvent.click(deleteItem);
    fireEvent.click(deleteItem);
    expect(onDeleteLearnerData).toHaveBeenCalledTimes(2);

    acceptedCompletion.resolve();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
