import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { readAaisBuildDeploymentId } from "./src/lib/build/aais-next-deployment-id";
export { createAaisContentSecurityPolicy } from "./src/lib/server/aais-csp";

const nextConfig: NextConfig = {
  output: "standalone",
  deploymentId: readAaisBuildDeploymentId(),
  // Preserve the project-owned agents.md instead of letting Next dev rewrite it.
  agentRules: false,
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "aais.site",
          },
        ],
        destination: "https://www.aais.site/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
        ],
      },
    ];
  },
};

const sentryBuildConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: {
    disable: !sentryBuildConfigured,
  },
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
  _experimental: {
    vercelCronsMonitoring: true,
  },
});
