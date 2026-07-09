import { type NextRequest, NextResponse } from "next/server";
import {
  createAaisContentSecurityPolicy,
  createAaisCspNonce,
} from "@/lib/server/aais-csp";

export function middleware(request: NextRequest) {
  const nonce = createAaisCspNonce();
  const contentSecurityPolicy = createAaisContentSecurityPolicy({
    nonce,
    env: process.env,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
