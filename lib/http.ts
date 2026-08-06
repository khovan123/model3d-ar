import type { NextRequest } from "next/server";

export function isAuthorized(request: NextRequest) {
  const configuredToken = process.env.ADMIN_UPLOAD_TOKEN?.trim();
  if (!configuredToken) return true;
  return request.headers.get("x-upload-token") === configuredToken;
}

export function getPublicOrigin(request: NextRequest) {
  const configured = process.env.APP_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  return request.nextUrl.origin;
}
