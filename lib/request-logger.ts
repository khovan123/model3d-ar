import { NextRequest, NextResponse } from "next/server";

const REQUEST_ID_HEADER = "x-request-id";
const SENSITIVE_QUERY_KEYS = /token|key|secret|signature|password|authorization/i;
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m"
} as const;

type RouteHandler<Context> = (
  request: NextRequest,
  context: Context
) => Response | Promise<Response>;

type ErrorContext = {
  code?: string;
  routeContext?: Record<string, unknown>;
};

export class RequestError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly code?: string;

  constructor(
    status: number,
    publicMessage: string,
    options: { cause?: unknown; code?: string } = {}
  ) {
    super(publicMessage, { cause: options.cause });
    this.name = "RequestError";
    this.status = status;
    this.publicMessage = publicMessage;
    this.code = options.code;
  }
}

function safePath(value: string) {
  try {
    const url = new URL(value, "http://localhost");
    url.searchParams.forEach((_item, key) => {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    });
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function requestIdFromHeaders(headers: Headers | Record<string, string | string[] | undefined>) {
  if (headers instanceof Headers) return headers.get(REQUEST_ID_HEADER) ?? "unknown";
  const value = headers[REQUEST_ID_HEADER] ?? headers[REQUEST_ID_HEADER.toUpperCase()];
  return Array.isArray(value) ? value[0] ?? "unknown" : value ?? "unknown";
}

function colorize(text: string, color: keyof typeof colors) {
  return `${colors[color]}${text}${colors.reset}`;
}

function formatTime() {
  return colorize(new Date().toISOString().slice(11, 23), "dim");
}

function formatMethod(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
      return colorize(method, "cyan");
    case "POST":
      return colorize(method, "green");
    case "PUT":
    case "PATCH":
    case "DELETE":
      return colorize(method, "yellow");
    default:
      return colorize(method, "magenta");
  }
}

function formatStatus(status: number) {
  const value = String(status);
  if (status >= 500) return colorize(value, "red");
  if (status >= 400) return colorize(value, "yellow");
  if (status >= 300) return colorize(value, "cyan");
  return colorize(value, "green");
}

function formatDuration(startedAt: number) {
  return colorize(`${(performance.now() - startedAt).toFixed(1)}ms`, "dim");
}

function formatRequestId(requestId: string) {
  return colorize(requestId, "magenta");
}

function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { message: "Cause chain truncated" };
  if (!(error instanceof Error)) return { value: String(error) };

  const digest = "digest" in error ? String(error.digest) : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(digest ? { digest } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause ? { cause: errorDetails(error.cause, depth + 1) } : {})
  };
}

function clientIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

export function getRequestId(request: NextRequest) {
  return request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
}

export function logRequestStarted(request: NextRequest, requestId: string) {
  console.info(
    `${formatTime()} ${colorize("[HTTP START]", "cyan")} ${formatMethod(request.method)} ${colorize(safePath(request.url), "blue")} requestId=${formatRequestId(requestId)} ip=${clientIp(request)}`
  );
}

function logRequestCompleted(
  request: NextRequest,
  response: Response,
  startedAt: number,
  requestId: string
) {
  const level = response.status >= 500 ? console.error : response.status >= 400 ? console.warn : console.info;
  level(
    `${formatTime()} ${colorize("[HTTP END]", response.status >= 500 ? "red" : response.status >= 400 ? "yellow" : "green")} ${formatMethod(request.method)} ${colorize(safePath(request.url), "blue")} status=${formatStatus(response.status)} duration=${formatDuration(startedAt)} requestId=${formatRequestId(requestId)}`
  );
}

export function logRequestError(
  request: NextRequest,
  error: unknown,
  startedAt: number,
  context: ErrorContext = {}
) {
  const requestId = getRequestId(request);
  console.error(
    `${formatTime()} ${colorize("[HTTP ERROR]", "red")} ${formatMethod(request.method)} ${colorize(safePath(request.url), "blue")} duration=${formatDuration(startedAt)} requestId=${formatRequestId(requestId)}`,
    {
      requestId,
      method: request.method,
      path: safePath(request.url),
      code: context.code,
      userAgent: request.headers.get("user-agent") ?? "unknown",
      ip: clientIp(request),
      routeContext: context.routeContext,
      error: errorDetails(error)
    }
  );
}

export function logWarning(message: string, error?: unknown, context?: Record<string, unknown>) {
  console.warn(`${formatTime()} ${colorize("[WARNING]", "yellow")} ${message}`, {
    ...context,
    ...(error === undefined ? {} : { error: errorDetails(error) })
  });
}

export function withRequestLogging<Context>(handler: RouteHandler<Context>): RouteHandler<Context> {
  return async (request, context) => {
    const startedAt = performance.now();
    const requestId = getRequestId(request);

    try {
      const response = await handler(request, context);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      logRequestCompleted(request, response, startedAt, requestId);
      return response;
    } catch (error) {
      const knownError = error instanceof RequestError ? error : null;
      const status = knownError?.status ?? 500;
      const message = knownError?.publicMessage ?? "Đã xảy ra lỗi máy chủ. Vui lòng thử lại.";

      logRequestError(request, error, startedAt, { code: knownError?.code });

      const response = NextResponse.json(
        { message, requestId },
        { status, headers: { [REQUEST_ID_HEADER]: requestId } }
      );
      logRequestCompleted(request, response, startedAt, requestId);
      return response;
    }
  };
}

export function logUnhandledRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: Record<string, unknown>
) {
  const requestId = requestIdFromHeaders(request.headers);
  console.error(`${formatTime()} ${colorize("[UNHANDLED SERVER ERROR]", "red")} ${formatMethod(request.method)} ${colorize(safePath(request.path), "blue")} requestId=${formatRequestId(requestId)}`, {
    requestId,
    method: request.method,
    path: safePath(request.path),
    context,
    error: errorDetails(error)
  });
}
