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
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";

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

  function getContentPanelWidthFromClientX(clientX: number) {
    const layoutRect = splitLayoutRef.current?.getBoundingClientRect();
    if (!layoutRect) {
      return null;
    }
    return clampContentPanelWidth(layoutRect.right - clientX);
  }

  function resizeContentPanelFromClientX(clientX: number) {
    const nextWidth = getContentPanelWidthFromClientX(clientX);
    if (nextWidth === null) {
      return null;
    }
    setContentPanelWidth(nextWidth);
    return nextWidth;
  }

  function resizeContentPanelBy(delta: number) {
    setContentPanelWidth((currentWidth) => clampContentPanelWidth(currentWidth + delta));
  }

  function startContentPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const initialWidth = contentPanelWidth;
    const nextWidth = getContentPanelWidthFromClientX(event.clientX);
    const operationId = createAaisResearchOperationId("panel-resize");
    event.preventDefault();
    if (nextWidth === null || !admitAaisResearchAction({
      eventName: "panel_resize_completed",
      outcome: "attempted",
      detail: {
        operation_id: operationId,
        input_method: "pointer",
        trigger: "pointer_start",
        width_px: nextWidth,
        delta_px: nextWidth - initialWidth,
      },
    })) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeContentPanelFromClientX(event.clientX);
    let finalWidth = nextWidth;

    const previousResizeState = document.body.getAttribute("data-aais-panel-resizing");
    document.body.setAttribute("data-aais-panel-resizing", "true");

    function stopResize(stopEvent: PointerEvent) {
      if (previousResizeState === null) {
        document.body.removeAttribute("data-aais-panel-resizing");
      } else {
        document.body.setAttribute("data-aais-panel-resizing", previousResizeState);
      }
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
      if (Math.round(finalWidth) !== Math.round(initialWidth)) {
        recordAaisResearchEvent({
          eventName: "panel_resize_completed",
          outcome: stopEvent.type === "pointercancel" ? "failure" : "success",
          detail: {
            operation_id: operationId,
            input_method: "pointer",
            trigger: stopEvent.type === "pointercancel" ? "pointer_cancel" : "pointer_end",
            width_px: finalWidth,
            delta_px: finalWidth - initialWidth,
          },
        });
      }
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      finalWidth = resizeContentPanelFromClientX(moveEvent.clientX) ?? finalWidth;
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
