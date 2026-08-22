import type { Locale } from "@/data/aais";

export type AaisQuadraticFunctionVisualization = {
  id: string;
  type: "quadratic-function";
  expression: string;
  coefficients: {
    a: number;
    b: number;
    c: number;
  };
  domain: {
    xMin: number;
    xMax: number;
  };
  vertex: {
    x: number;
    y: number;
  };
  axisX: number;
  yIntercept: number;
};

export type AaisGuideVisualization = AaisQuadraticFunctionVisualization;

export type AaisFunctionScaffoldMode = "visualize" | "demonstrate";

export type AaisFunctionScaffoldPlan = {
  mode: AaisFunctionScaffoldMode;
  visualization: AaisQuadraticFunctionVisualization;
};

type ConversationMessage = {
  kind: "user" | "assistant";
  text: string;
};

const graphIntentPatterns = [
  /函数图像|函数图象|图像|图象|抛物线|曲线/i,
  /(?:看|显示|展示|画|生成).{0,8}(?:函数)?(?:图像|图象|图形|曲线)/i,
  /(?:函数)?(?:图像|图象|图形|曲线).{0,8}(?:看|显示|展示|画|生成)/i,
  /(?:show|display|draw|plot|graph).{0,24}(?:function|quadratic|parabola|curve|graph)/i,
  /(?:function|quadratic|parabola|curve).{0,24}(?:show|display|draw|plot|graph)/i,
  /\b(?:graph|plot)\b/i,
];

const difficultyIntentPatterns = [
  /不会|不懂|不知道|没办法|算不出|算不来|帮我算|替我算|给我示范|直接告诉我|还是想看图/i,
  /(?:i\s+)?(?:do not|don't|cannot|can't)\s+(?:know|understand|calculate|work it out)/i,
  /help\s+me\s+(?:calculate|work|solve)|show\s+me\s+how|give\s+me\s+the\s+answer/i,
];

const calculationGatePatterns = [
  /代入|算(?:一下|出来|出)|等于多少|顶点横坐标|再试一次/i,
  /substitute|calculate|work\s+out|try\s+again|vertex.{0,12}x/i,
];

const unsignedNumberPattern = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:/(?:\\d+(?:\\.\\d+)?|\\.\\d+))?";
const quadraticExpressionPattern = new RegExp(
  `[+-]?(?:${unsignedNumberPattern})?x\\^2(?:[+-](?:${unsignedNumberPattern})?x)?(?:[+-]${unsignedNumberPattern})?(?![+\\-\\dA-Za-z_^])`,
  "i",
);

export function createAaisFunctionScaffoldPlan(input: {
  learnerInput: string;
  conversationHistory?: ConversationMessage[];
}): AaisFunctionScaffoldPlan | null {
  const learnerInput = normalizeText(input.learnerInput);
  const history = (input.conversationHistory ?? []).slice(-10);
  const recentUserMessages = history
    .filter((message) => message.kind === "user")
    .map((message) => message.text);
  const currentGraphIntent = hasAaisGraphIntent(learnerInput);
  const recentGraphGoal = currentGraphIntent || recentUserMessages
    .slice(-6)
    .some((message) => hasAaisGraphIntent(message));

  if (!recentGraphGoal) {
    return null;
  }

  const parsed = findMostRecentQuadratic([
    input.learnerInput,
    ...recentUserMessages.slice().reverse(),
  ]);
  if (!parsed) {
    return null;
  }

  const lastAssistant = history.findLast((message) => message.kind === "assistant");
  const currentDifficulty = hasPattern(learnerInput, difficultyIntentPatterns);
  const answeringCalculationGate = Boolean(
    lastAssistant
    && hasPattern(normalizeText(lastAssistant.text), calculationGatePatterns)
    && isShortCalculationAttempt(learnerInput),
  );
  if (!currentGraphIntent && !currentDifficulty && !answeringCalculationGate) {
    return null;
  }
  const mode: AaisFunctionScaffoldMode = currentDifficulty || answeringCalculationGate
    ? "demonstrate"
    : "visualize";

  return {
    mode,
    visualization: createQuadraticVisualization(parsed),
  };
}

export function isAaisFunctionGraphRequest(value: string) {
  const normalized = normalizeText(value);
  return hasAaisGraphIntent(normalized)
    && /函数|抛物线|曲线|二次|function|quadratic|parabola|y\s*=|x\s*(?:\^|\*\*|²)\s*\d/i.test(normalized);
}

export function hasAaisGraphIntent(value: string) {
  return hasPattern(normalizeText(value), graphIntentPatterns);
}

export function createAaisUnsupportedFunctionGraphResponse(locale: Locale) {
  return locale === "en-US"
    ? "I can currently draw verified quadratic graphs in the form y = ax² + bx + c, but I cannot safely display this expression yet. Rewrite it in that form and I will show the graph immediately without requiring you to calculate first."
    : "我目前可以安全绘制 y = ax² + bx + c 形式的二次函数，但这个表达式暂时不能直接显示。请把它改写成这个形式；我会立即显示图像，不要求你先计算。";
}

export function createAaisFunctionScaffoldResponse(
  plan: AaisFunctionScaffoldPlan,
  locale: Locale,
) {
  const { a, b, c } = plan.visualization.coefficients;
  const vertexX = formatAaisMathNumber(plan.visualization.vertex.x);
  const vertexY = formatAaisMathNumber(plan.visualization.vertex.y);
  const decimalY = formatAaisDecimal(plan.visualization.vertex.y);

  if (locale === "en-US") {
    if (plan.mode === "demonstrate") {
      return `No problem—here is the worked step: y = ${formatAaisDecimal(a)} × (${vertexX})² ${formatSignedTerm(b, vertexX)} ${formatSignedConstant(c)} = ${vertexY}${decimalY !== vertexY ? ` (${decimalY})` : ""}. The graph is shown below with the vertex (${vertexX}, ${vertexY}); you do not need to calculate it correctly before seeing the visual.`;
    }
    return `Of course—look at the graph first. It is shown below with the vertex (${vertexX}, ${vertexY}), symmetry axis, and y-intercept; calculation is not a prerequisite for using this visual scaffold.`;
  }

  if (plan.mode === "demonstrate") {
    return `没关系，我来示范：y = ${formatAaisDecimal(a)} × (${vertexX})² ${formatSignedTerm(b, vertexX)} ${formatSignedConstant(c)} = ${vertexY}${decimalY !== vertexY ? `（${decimalY}）` : ""}。图像已显示在下面并标出顶点（${vertexX}，${vertexY}）；不用先算对才能看图。`;
  }
  return `当然，先看图。图像已显示在下面，并标出顶点（${vertexX}，${vertexY}）、对称轴和 y 轴截距；计算不是看图的前置条件。`;
}

export function normalizeAaisGuideVisualizations(value: unknown): AaisGuideVisualization[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 2)
    .filter(isAaisQuadraticFunctionVisualization)
    .map((visualization) => ({
      ...visualization,
      coefficients: { ...visualization.coefficients },
      domain: { ...visualization.domain },
      vertex: { ...visualization.vertex },
    }));
}

export function evaluateAaisQuadratic(
  coefficients: AaisQuadraticFunctionVisualization["coefficients"],
  x: number,
) {
  return coefficients.a * x * x + coefficients.b * x + coefficients.c;
}

export function formatAaisMathNumber(value: number) {
  const normalized = normalizeNegativeZero(value);
  const fraction = toSimpleFraction(normalized);
  return fraction ?? formatAaisDecimal(normalized);
}

export function formatAaisDecimal(value: number) {
  return normalizeNegativeZero(value).toLocaleString("en-US", {
    maximumFractionDigits: 4,
    useGrouping: false,
  });
}

function findMostRecentQuadratic(values: string[]) {
  for (const value of values) {
    const parsed = parseQuadraticExpression(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function parseQuadraticExpression(value: string) {
  const normalized = normalizeExpression(value);
  const candidate = normalized.match(quadraticExpressionPattern)?.[0];
  if (!candidate) {
    return null;
  }

  let a = 0;
  let b = 0;
  let c = 0;
  const terms = candidate.match(/[+-]?[^+-]+/g) ?? [];
  for (const term of terms) {
    if (term.endsWith("x^2")) {
      a += parseCoefficient(term.slice(0, -3));
    } else if (term.endsWith("x")) {
      b += parseCoefficient(term.slice(0, -1));
    } else {
      c += parseNumericValue(term);
    }
  }

  if (![a, b, c].every(isSafeCoefficient) || a === 0) {
    return null;
  }
  const vertexX = -b / (2 * a);
  const vertexY = evaluateAaisQuadratic({ a, b, c }, vertexX);
  if (![vertexX, vertexY].every((number) => Number.isFinite(number) && Math.abs(number) <= 1_000_000)) {
    return null;
  }
  return { a, b, c };
}

function createQuadraticVisualization(coefficients: { a: number; b: number; c: number }) {
  const vertexX = normalizeNegativeZero(-coefficients.b / (2 * coefficients.a));
  const vertexY = normalizeNegativeZero(evaluateAaisQuadratic(coefficients, vertexX));
  const halfWidth = 4;
  return {
    id: `quadratic-${encodeNumber(coefficients.a)}-${encodeNumber(coefficients.b)}-${encodeNumber(coefficients.c)}`,
    type: "quadratic-function" as const,
    expression: formatQuadraticExpression(coefficients),
    coefficients,
    domain: {
      xMin: Math.floor(vertexX - halfWidth),
      xMax: Math.ceil(vertexX + halfWidth),
    },
    vertex: {
      x: vertexX,
      y: vertexY,
    },
    axisX: vertexX,
    yIntercept: coefficients.c,
  };
}

function normalizeExpression(value: string) {
  return normalizeText(
    value
      .replace(/²/g, "^2")
      .replace(/\*\*2/g, "^2"),
  )
    .replace(/[×·]/g, "*")
    .replace(/\s+/g, "")
    .replace(/\*/g, "");
}

function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/＋/g, "+")
    .replace(/＝/g, "=")
    .trim();
}

function hasPattern(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function isShortCalculationAttempt(value: string) {
  return /^(?:[xy]\s*=\s*)?[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(?:\d+(?:\.\d+)?|\.\d+))?\s*[?？]?$/i.test(value);
}

function parseCoefficient(value: string) {
  if (!value || value === "+") {
    return 1;
  }
  if (value === "-") {
    return -1;
  }
  return parseNumericValue(value);
}

function parseNumericValue(value: string) {
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function isSafeCoefficient(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= 10_000;
}

function isAaisQuadraticFunctionVisualization(
  value: unknown,
): value is AaisQuadraticFunctionVisualization {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AaisQuadraticFunctionVisualization>;
  return candidate.type === "quadratic-function"
    && typeof candidate.id === "string"
    && candidate.id.length <= 128
    && typeof candidate.expression === "string"
    && candidate.expression.length <= 160
    && isCoordinateRecord(candidate.coefficients, ["a", "b", "c"])
    && candidate.coefficients.a !== 0
    && isCoordinateRecord(candidate.domain, ["xMin", "xMax"])
    && candidate.domain.xMin < candidate.domain.xMax
    && isCoordinateRecord(candidate.vertex, ["x", "y"])
    && isBoundedNumber(candidate.axisX)
    && isBoundedNumber(candidate.yIntercept);
}

function isCoordinateRecord(
  value: unknown,
  keys: string[],
): value is Record<string, number> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return keys.every((key) => isBoundedNumber(record[key]));
}

function isBoundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function formatQuadraticExpression({ a, b, c }: { a: number; b: number; c: number }) {
  return `y = ${formatLeadingCoefficient(a)}x²${formatSignedCoefficient(b, "x")}${formatSignedCoefficient(c, "")}`;
}

function formatLeadingCoefficient(value: number) {
  if (value === 1) {
    return "";
  }
  if (value === -1) {
    return "-";
  }
  return formatAaisMathNumber(value);
}

function formatSignedCoefficient(value: number, suffix: string) {
  if (value === 0) {
    return "";
  }
  const sign = value > 0 ? " + " : " - ";
  const absolute = Math.abs(value);
  const coefficient = suffix && absolute === 1 ? "" : formatAaisMathNumber(absolute);
  return `${sign}${coefficient}${suffix}`;
}

function formatSignedTerm(coefficient: number, x: string) {
  const sign = coefficient >= 0 ? "+" : "−";
  return `${sign} ${formatAaisDecimal(Math.abs(coefficient))} × (${x})`;
}

function formatSignedConstant(value: number) {
  const sign = value >= 0 ? "+" : "−";
  return `${sign} ${formatAaisDecimal(Math.abs(value))}`;
}

function toSimpleFraction(value: number) {
  if (Number.isInteger(value)) {
    return null;
  }
  for (let denominator = 2; denominator <= 16; denominator += 1) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(value - numerator / denominator) < 1e-10) {
      const divisor = greatestCommonDivisor(Math.abs(numerator), denominator);
      return `${numerator / divisor}/${denominator / divisor}`;
    }
  }
  return null;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

function normalizeNegativeZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function encodeNumber(value: number) {
  return formatAaisDecimal(value).replace("-", "m").replace(".", "p");
}
