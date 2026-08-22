import { AaisApiRouteError } from "@/lib/server/aais-api-error";

const aaisLearningRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type AaisLearningRequestIdError = {
  code: string;
  message: string;
};

type AaisRequiredLearningRequestIdErrors = {
  required: AaisLearningRequestIdError;
  invalid: AaisLearningRequestIdError;
};

export function requireAaisLearningRequestId(
  value: unknown,
  errors: AaisRequiredLearningRequestIdErrors,
) {
  if (typeof value !== "string" || value.length === 0) {
    throwRequestIdError(errors.required);
  }
  if (!aaisLearningRequestIdPattern.test(value)) {
    throwRequestIdError(errors.invalid);
  }
  return value;
}

export function readOptionalAaisLearningRequestId(
  value: unknown,
  invalid: AaisLearningRequestIdError,
) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !aaisLearningRequestIdPattern.test(value)) {
    throwRequestIdError(invalid);
  }
  return value;
}

function throwRequestIdError(error: AaisLearningRequestIdError): never {
  throw new AaisApiRouteError({
    ...error,
    status: 400,
  });
}
