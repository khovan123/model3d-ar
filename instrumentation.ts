import type { Instrumentation } from "next";
import { logUnhandledRequestError } from "@/lib/request-logger";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  logUnhandledRequestError(error, request, context as unknown as Record<string, unknown>);
};
