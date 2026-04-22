import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] ||
    (statusCode >= 500
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse Antigravity error message to extract retry time
 * Example: "You have exhausted your capacity on this model. Your quota will reset after 2h7m23s."
 * @param {string} message - Error message
 * @returns {number|null} Retry time in milliseconds, or null if not found
 */
export function parseAntigravityRetryTime(message) {
  if (typeof message !== "string") return null;

  // Match patterns like: 2h7m23s, 5m30s, 45s, 1h20m, etc.
  const match = message.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
  if (!match) return null;

  let totalMs = 0;

  // Extract hours
  if (match[1]) {
    const hours = parseInt(match[1]);
    totalMs += hours * 60 * 60 * 1000;
  }

  // Extract minutes
  if (match[2]) {
    const minutes = parseInt(match[2]);
    totalMs += minutes * 60 * 1000;
  }

  // Extract seconds
  if (match[3]) {
    const seconds = parseInt(match[3]);
    totalMs += seconds * 1000;
  }

  return totalMs > 0 ? totalMs : null;
}

/**
 * Parse rate limit reset time from response headers
 * OpenAI returns x-ratelimit-reset-requests and x-ratelimit-reset-tokens
 * @param {Headers} headers - Response headers
 * @returns {number|null} Milliseconds until reset, or null if not found
 */
export function parseRateLimitResetFromHeaders(headers) {
  if (!headers) return null;

  // Try x-ratelimit-reset-tokens first (most relevant for quota)
  const resetTokens = headers.get('x-ratelimit-reset-tokens');
  if (resetTokens) {
    try {
      const resetDate = new Date(resetTokens);
      const diffMs = resetDate.getTime() - Date.now();
      if (diffMs > 0) return diffMs;
    } catch {
      // Invalid date format, continue
    }
  }

  // Try x-ratelimit-reset-requests
  const resetRequests = headers.get('x-ratelimit-reset-requests');
  if (resetRequests) {
    try {
      const resetDate = new Date(resetRequests);
      const diffMs = resetDate.getTime() - Date.now();
      if (diffMs > 0) return diffMs;
    } catch {
      // Invalid date format, continue
    }
  }

  // Try standard Retry-After header (seconds or HTTP-date)
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    // Try as seconds first
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }

    // Try as HTTP-date
    try {
      const date = new Date(retryAfter);
      const diffMs = date.getTime() - Date.now();
      if (diffMs > 0) return diffMs;
    } catch {
      // Invalid date format
    }
  }

  // Try x-ratelimit-reset (Unix timestamp in seconds)
  const resetTimestamp = headers.get('x-ratelimit-reset');
  if (resetTimestamp) {
    const ts = parseInt(resetTimestamp, 10);
    if (!isNaN(ts)) {
      const diffMs = (ts * 1000) - Date.now();
      if (diffMs > 0) return diffMs;
    }
  }

  return null;
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {string} provider - Provider name (for provider-specific parsing)
 * @returns {Promise<{statusCode: number, message: string, retryAfterMs: number|null}>}
 */
export async function parseUpstreamError(response, provider = null) {
  let message = "";
  let retryAfterMs = null;

  try {
    const text = await response.text();

    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || json.error || text;
    } catch {
      message = text;
    }
  } catch {
    message = `Upstream error: ${response.status}`;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Parse retry time from headers (works for OpenAI/Codex and others)
  retryAfterMs = parseRateLimitResetFromHeaders(response.headers);

  // Fallback: Parse Antigravity-specific retry time from error message
  if (!retryAfterMs && provider === "antigravity" && response.status === 429) {
    retryAfterMs = parseAntigravityRetryTime(finalMessage);
  }

  return {
    statusCode: response.status,
    message: finalMessage,
    retryAfterMs
  };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {{ success: false, status: number, error: string, response: Response }}
 */
export function createErrorResult(statusCode, message, retryAfterMs = null) {
  const result = {
    success: false,
    status: statusCode,
    error: message,
    response: errorResponse(statusCode, message)
  };

  // Add retryAfterMs if available
  if (retryAfterMs) {
    result.retryAfterMs = retryAfterMs;
  }

  return result;
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
