"use client";

import { useId } from "react";
import type { Locale } from "@/data/aais";
import {
  evaluateAaisQuadratic,
  formatAaisDecimal,
  formatAaisMathNumber,
  type AaisQuadraticFunctionVisualization,
} from "@/lib/ai/aais-guide-function-scaffold";

const viewBox = {
  width: 640,
  height: 360,
  left: 64,
  right: 24,
  top: 24,
  bottom: 52,
};

type FunctionGraphProps = {
  disabled?: boolean;
  locale: Locale;
  onSuggestedPrompt?: (prompt: string) => void;
  visualization: AaisQuadraticFunctionVisualization;
};

export function FunctionGraph({
  disabled = false,
  locale,
  onSuggestedPrompt,
  visualization,
}: FunctionGraphProps) {
  const id = useId().replace(/:/g, "");
  const copy = createFunctionGraphCopy(locale, visualization);
  const geometry = createGraphGeometry(visualization);
  const titleId = `function-graph-title-${id}`;
  const descriptionId = `function-graph-description-${id}`;
  const clipPathId = `function-graph-clip-${id}`;

  return (
    <figure
      className="mt-4 min-w-0 max-w-full overflow-hidden rounded-2xl border border-[#dbe2f2] bg-[#fbfcff] shadow-[0_8px_24px_rgba(31,79,134,0.08)]"
      data-testid="quadratic-function-graph"
    >
      <div className="border-b border-[#e4e9f4] bg-white px-4 py-3 sm:px-5">
        <p className="text-sm font-semibold text-[#1f4f86]">{copy.eyebrow}</p>
        <h3 className="mt-1 break-words font-mono text-base font-semibold text-[#202938]">
          {visualization.expression}
        </h3>
        <p className="mt-1 text-sm leading-6 text-[#59657a]">{copy.summary}</p>
      </div>

      <div className="px-2 py-3 sm:px-4">
        <svg
          aria-labelledby={`${titleId} ${descriptionId}`}
          className="h-auto w-full"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
        >
          <title id={titleId}>{copy.svgTitle}</title>
          <desc id={descriptionId}>{copy.svgDescription}</desc>
          <defs>
            <clipPath id={clipPathId}>
              <rect
                height={geometry.plotHeight}
                width={geometry.plotWidth}
                x={viewBox.left}
                y={viewBox.top}
              />
            </clipPath>
          </defs>

          <rect
            className="fill-white stroke-[#dbe2f2]"
            height={geometry.plotHeight}
            width={geometry.plotWidth}
            x={viewBox.left}
            y={viewBox.top}
          />

          <g aria-hidden="true" className="stroke-[#e8ecf4]" strokeWidth="1">
            {geometry.xTicks.map((tick) => (
              <line
                key={`x-grid-${tick.value}`}
                x1={tick.position}
                x2={tick.position}
                y1={viewBox.top}
                y2={viewBox.top + geometry.plotHeight}
              />
            ))}
            {geometry.yTicks.map((tick) => (
              <line
                key={`y-grid-${tick.value}`}
                x1={viewBox.left}
                x2={viewBox.left + geometry.plotWidth}
                y1={tick.position}
                y2={tick.position}
              />
            ))}
          </g>

          <g aria-hidden="true" className="fill-[#526071] text-[12px]">
            {geometry.xTicks.map((tick) => (
              <text
                key={`x-label-${tick.value}`}
                textAnchor="middle"
                x={tick.position}
                y={viewBox.top + geometry.plotHeight + 22}
              >
                {formatAaisDecimal(tick.value)}
              </text>
            ))}
            {geometry.yTicks.map((tick) => (
              <text
                dominantBaseline="middle"
                key={`y-label-${tick.value}`}
                textAnchor="end"
                x={viewBox.left - 9}
                y={tick.position}
              >
                {formatAaisDecimal(tick.value)}
              </text>
            ))}
            <text
              className="font-semibold"
              textAnchor="end"
              x={viewBox.left + geometry.plotWidth}
              y={viewBox.height - 8}
            >
              x
            </text>
            <text
              className="font-semibold"
              x={14}
              y={viewBox.top + 5}
            >
              y
            </text>
          </g>

          {geometry.xAxisY !== null ? (
            <line
              aria-hidden="true"
              className="stroke-[#6c7789]"
              strokeWidth="1.5"
              x1={viewBox.left}
              x2={viewBox.left + geometry.plotWidth}
              y1={geometry.xAxisY}
              y2={geometry.xAxisY}
            />
          ) : null}
          {geometry.yAxisX !== null ? (
            <line
              aria-hidden="true"
              className="stroke-[#6c7789]"
              strokeWidth="1.5"
              x1={geometry.yAxisX}
              x2={geometry.yAxisX}
              y1={viewBox.top}
              y2={viewBox.top + geometry.plotHeight}
            />
          ) : null}

          <g clipPath={`url(#${clipPathId})`}>
            <line
              aria-hidden="true"
              className="stroke-[#bd6d25]"
              strokeDasharray="7 6"
              strokeWidth="2"
              x1={geometry.vertex.x}
              x2={geometry.vertex.x}
              y1={viewBox.top}
              y2={viewBox.top + geometry.plotHeight}
            />
            <path
              aria-hidden="true"
              className="fill-none stroke-[#3559d5]"
              d={geometry.path}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="4"
            />
          </g>

          <g>
            <circle
              className="fill-white stroke-[#9a4f18]"
              cx={geometry.vertex.x}
              cy={geometry.vertex.y}
              r="7"
              strokeWidth="4"
            >
              <title>{copy.vertexTooltip}</title>
            </circle>
            <text
              className="fill-[#783c13] text-[12px] font-semibold"
              textAnchor={geometry.vertex.x > viewBox.width - 150 ? "end" : "start"}
              x={geometry.vertex.x + (geometry.vertex.x > viewBox.width - 150 ? -10 : 10)}
              y={Math.max(viewBox.top + 16, geometry.vertex.y - 12)}
            >
              {copy.vertexLabel}
            </text>
            {geometry.yIntercept ? (
              <circle
                className="fill-[#3559d5] stroke-white"
                cx={geometry.yIntercept.x}
                cy={geometry.yIntercept.y}
                r="6"
                strokeWidth="3"
              >
                <title>{copy.yInterceptTooltip}</title>
              </circle>
            ) : null}
          </g>
        </svg>
      </div>

      <div className="border-t border-[#e4e9f4] bg-white px-4 py-4 sm:px-5">
        <div aria-label={copy.legendLabel} className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-[#465166]">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-1 w-7 rounded-full bg-[#3559d5]" />
            {copy.curveLegend}
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-0 w-7 border-t-2 border-dashed border-[#bd6d25]" />
            {copy.axisLegend}
          </span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[360px] border-collapse text-left text-sm text-[#374154]">
            <caption className="mb-2 text-left font-semibold text-[#202938]">
              {copy.tableCaption}
            </caption>
            <thead>
              <tr className="border-b border-[#dfe5f0] text-[#59657a]">
                <th className="py-2 pr-4 font-semibold" scope="col">{copy.pointColumn}</th>
                <th className="px-4 py-2 font-semibold" scope="col">x</th>
                <th className="py-2 pl-4 font-semibold" scope="col">y</th>
              </tr>
            </thead>
            <tbody>
              {copy.tableRows.map((row) => (
                <tr className="border-b border-[#edf0f6] last:border-0" key={row.label}>
                  <th className="py-2 pr-4 font-medium" scope="row">{row.label}</th>
                  <td className="px-4 py-2 font-mono">{row.x}</td>
                  <td className="py-2 pl-4 font-mono">{row.y}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {onSuggestedPrompt ? (
          <div className="mt-4">
            <p className="text-sm font-semibold text-[#30394b]">{copy.nextStepLabel}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {copy.suggestions.map((suggestion) => (
                <button
                  className="min-h-11 rounded-full border border-[#cbd5ee] bg-white px-4 py-2 text-sm font-semibold text-[#294b9a] outline-none transition-colors hover:bg-[#eef3ff] focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disabled}
                  key={suggestion.label}
                  onClick={() => onSuggestedPrompt(suggestion.prompt)}
                  type="button"
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </figure>
  );
}

function createGraphGeometry(visualization: AaisQuadraticFunctionVisualization) {
  const plotWidth = viewBox.width - viewBox.left - viewBox.right;
  const plotHeight = viewBox.height - viewBox.top - viewBox.bottom;
  const { xMin, xMax } = visualization.domain;
  const samples = Array.from({ length: 121 }, (_, index) => {
    const x = xMin + ((xMax - xMin) * index) / 120;
    return {
      x,
      y: evaluateAaisQuadratic(visualization.coefficients, x),
    };
  });
  const sampleValues = samples.map((sample) => sample.y);
  const rawYMin = Math.min(0, ...sampleValues);
  const rawYMax = Math.max(0, ...sampleValues);
  const ySpan = Math.max(1, rawYMax - rawYMin);
  const yMin = rawYMin - ySpan * 0.08;
  const yMax = rawYMax + ySpan * 0.08;
  const mapX = (x: number) => viewBox.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const mapY = (y: number) => viewBox.top + ((yMax - y) / (yMax - yMin)) * plotHeight;
  const path = samples
    .map((sample, index) => `${index === 0 ? "M" : "L"}${mapX(sample.x).toFixed(2)},${mapY(sample.y).toFixed(2)}`)
    .join(" ");
  const createTicks = (min: number, max: number, mapper: (value: number) => number) =>
    Array.from({ length: 5 }, (_, index) => {
      const value = min + ((max - min) * index) / 4;
      return {
        value: normalizeTinyNumber(value),
        position: mapper(value),
      };
    });
  const yInterceptVisible = 0 >= xMin && 0 <= xMax
    && visualization.yIntercept >= yMin && visualization.yIntercept <= yMax;

  return {
    path,
    plotHeight,
    plotWidth,
    vertex: {
      x: mapX(visualization.vertex.x),
      y: mapY(visualization.vertex.y),
    },
    xAxisY: 0 >= yMin && 0 <= yMax ? mapY(0) : null,
    yAxisX: 0 >= xMin && 0 <= xMax ? mapX(0) : null,
    xTicks: createTicks(xMin, xMax, mapX),
    yTicks: createTicks(yMin, yMax, mapY).reverse(),
    yIntercept: yInterceptVisible
      ? { x: mapX(0), y: mapY(visualization.yIntercept) }
      : null,
  };
}

function createFunctionGraphCopy(
  locale: Locale,
  visualization: AaisQuadraticFunctionVisualization,
) {
  const vertexX = formatAaisMathNumber(visualization.vertex.x);
  const vertexY = formatAaisMathNumber(visualization.vertex.y);
  const sideXLeft = visualization.vertex.x - 1;
  const sideXRight = visualization.vertex.x + 1;
  const sideY = evaluateAaisQuadratic(visualization.coefficients, sideXLeft);
  const opensUp = visualization.coefficients.a > 0;
  const suggestions = locale === "en-US"
    ? [
        { label: "Explain the vertex", prompt: `Please explain how the vertex of ${visualization.expression} is found.` },
        { label: "Show the substitution", prompt: `Please demonstrate substituting x = ${vertexX} into ${visualization.expression}.` },
        { label: "Let me observe first", prompt: `I want to observe the graph of ${visualization.expression} first. What should I notice?` },
      ]
    : [
        { label: "解释顶点", prompt: `请解释 ${visualization.expression} 的顶点是怎么得到的。` },
        { label: "示范代入", prompt: `请示范把 x = ${vertexX} 代入 ${visualization.expression}。` },
        { label: "我先观察", prompt: `我想先观察 ${visualization.expression} 的图像，请告诉我应该注意什么。` },
      ];
  const tableRows = [
    {
      label: locale === "en-US" ? "Vertex" : "顶点",
      x: vertexX,
      y: vertexY,
    },
    {
      label: locale === "en-US" ? "Left reference point" : "左侧参考点",
      x: formatAaisMathNumber(sideXLeft),
      y: formatAaisMathNumber(sideY),
    },
    {
      label: locale === "en-US" ? "Right reference point" : "右侧参考点",
      x: formatAaisMathNumber(sideXRight),
      y: formatAaisMathNumber(sideY),
    },
    {
      label: locale === "en-US" ? "y-intercept" : "y 轴截距",
      x: "0",
      y: formatAaisMathNumber(visualization.yIntercept),
    },
  ];

  if (locale === "en-US") {
    return {
      eyebrow: "Function graph scaffold",
      summary: `This parabola opens ${opensUp ? "upward" : "downward"}. Its vertex is (${vertexX}, ${vertexY}) and its symmetry axis is x = ${vertexX}.`,
      svgTitle: `Graph of ${visualization.expression}`,
      svgDescription: `A parabola opening ${opensUp ? "upward" : "downward"}, with vertex at (${vertexX}, ${vertexY}), symmetry axis x = ${vertexX}, and y-intercept ${formatAaisMathNumber(visualization.yIntercept)}.`,
      vertexTooltip: `Vertex (${vertexX}, ${vertexY})`,
      vertexLabel: `Vertex (${vertexX}, ${vertexY})`,
      yInterceptTooltip: `y-intercept (0, ${formatAaisMathNumber(visualization.yIntercept)})`,
      legendLabel: "Graph legend",
      curveLegend: "Function curve",
      axisLegend: `Symmetry axis x = ${vertexX}`,
      tableCaption: "Key points in the graph",
      pointColumn: "Feature",
      nextStepLabel: "Choose how to continue",
      suggestions,
      tableRows,
    };
  }

  return {
    eyebrow: "函数图像脚手架",
    summary: `这条抛物线${opensUp ? "开口向上" : "开口向下"}，顶点是（${vertexX}，${vertexY}），对称轴是 x = ${vertexX}。`,
    svgTitle: `${visualization.expression} 的函数图像`,
    svgDescription: `一条${opensUp ? "开口向上" : "开口向下"}的抛物线，顶点为（${vertexX}，${vertexY}），对称轴为 x = ${vertexX}，y 轴截距为 ${formatAaisMathNumber(visualization.yIntercept)}。`,
    vertexTooltip: `顶点（${vertexX}，${vertexY}）`,
    vertexLabel: `顶点（${vertexX}，${vertexY}）`,
    yInterceptTooltip: `y 轴截距（0，${formatAaisMathNumber(visualization.yIntercept)}）`,
    legendLabel: "函数图像图例",
    curveLegend: "函数曲线",
    axisLegend: `对称轴 x = ${vertexX}`,
    tableCaption: "图像关键点",
    pointColumn: "特征",
    nextStepLabel: "选择接下来怎样学",
    suggestions,
    tableRows,
  };
}

function normalizeTinyNumber(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : value;
}
