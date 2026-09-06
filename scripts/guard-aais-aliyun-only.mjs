import { pathToFileURL } from "node:url";

export function assertAaisAliyunOnlyBuild(env) {
  // The entire candidate is deliberately unavailable to Vercel, including CLI
  // deployments and accidental merges; branch exclusions alone are insufficient.
  if (env.VERCEL || env.VERCEL_ENV) {
    throw new Error("AAIS_ALIYUN_CANDIDATE_NOT_APPROVED_FOR_VERCEL");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertAaisAliyunOnlyBuild(process.env);
  } catch {
    console.error("AAIS_ALIYUN_CANDIDATE_NOT_APPROVED_FOR_VERCEL");
    process.exitCode = 1;
  }
}
