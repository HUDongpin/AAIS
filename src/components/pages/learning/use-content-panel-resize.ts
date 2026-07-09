import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  defaultContentPanelWidth,
  maxContentPanelWidth,
  minContentPanelWidth,
  minGuidePanelWidth,
} from "@/components/pages/learning/learning-page-constants";

export function useContentPanelResize() {
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const [contentPanelWidth, setContentPanelWidth] = useState(defaultContentPanelWidth);

  function getMaxContentPanelWidth() {
    const layoutWidth = splitLayoutRef.current?.getBoundingClientRect().width;
    if (!layoutWidth) {
      return maxContentPanelWidth;
    }
    return Math.max(
      minContentPanelWidth,
      Math.min(maxContentPanelWidth, layoutWidth - minGuidePanelWidth),
    );
  }

  function clampContentPanelWidth(width: number) {
    return Math.min(Math.max(width, minContentPanelWidth), getMaxContentPanelWidth());
  }

  function resizeContentPanelFromClientX(clientX: number) {
    const layoutRect = splitLayoutRef.current?.getBoundingClientRect();
    if (!layoutRect) {
      return;
    }
    setContentPanelWidth(clampContentPanelWidth(layoutRect.right - clientX));
  }

  function resizeContentPanelBy(delta: number) {
    setContentPanelWidth((currentWidth) => clampContentPanelWidth(currentWidth + delta));
  }

  function startContentPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeContentPanelFromClientX(event.clientX);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function stopResize() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      resizeContentPanelFromClientX(moveEvent.clientX);
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", stopResize);
    document.addEventListener("pointercancel", stopResize);
  }

  return {
    contentPanelWidth,
    getMaxContentPanelWidth,
    resizeContentPanelBy,
    setContentPanelWidth,
    splitLayoutRef,
    startContentPanelResize,
  };
}
