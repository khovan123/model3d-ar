import type { NextRequest } from "next/server";

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

export type RouteTimer = {
  startedAt: number;
  startedAtDate: Date;
};

export function createRouteTimer(): RouteTimer {
  return {
    startedAt: performance.now(),
    startedAtDate: new Date()
  };
}

function colorize(text: string, color: keyof typeof colors) {
  return `${colors[color]}${text}${colors.reset}`;
}

function formatStatus(status: number) {
  const label = String(status);
  if (status >= 500) return colorize(label, "red");
  if (status >= 400) return colorize(label, "yellow");
  if (status >= 300) return colorize(label, "cyan");
  return colorize(label, "green");
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

function formatDuration(ms: number) {
  return colorize(`${ms.toFixed(1)}ms`, "dim");
}

function formatTime(date: Date) {
  return colorize(date.toISOString().slice(11, 23), "dim");
}

function toPathname(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const query = request.nextUrl.search;
  return `${path}${query}`;
}

export function logRoute(request: NextRequest, status: number, timer: RouteTimer) {
  const duration = performance.now() - timer.startedAt;
  console.log(
    `${formatTime(timer.startedAtDate)} ${formatMethod(request.method)} ${colorize(toPathname(request), "blue")} ${formatStatus(status)} ${formatDuration(duration)}`
  );
}

export function logRouteError(request: NextRequest, timer: RouteTimer) {
  const duration = performance.now() - timer.startedAt;
  console.error(
    `${formatTime(timer.startedAtDate)} ${formatMethod(request.method)} ${colorize(toPathname(request), "blue")} ${formatStatus(500)} ${formatDuration(duration)}`
  );
}
