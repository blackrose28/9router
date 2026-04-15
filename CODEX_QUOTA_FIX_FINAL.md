# Codex Quota Exhaustion Fix - Using Actual Reset Times

**Date:** 2026-04-14  
**Status:** ✅ Complete and Tested

## Problem Statement

When Codex (OpenAI) accounts hit quota limits (5-hour rolling window or weekly quota), the system was:
1. Treating them as temporary rate limits with exponential backoff (1-2 minutes)
2. Using a fixed 6-hour guess instead of the actual reset time from OpenAI's headers
3. Causing repeated failed requests every few minutes

## Solution Overview

Instead of guessing cooldown times, we now **extract the actual quota reset time from OpenAI's response headers** and use that precise timestamp.

## Changes Made

### 1. Enhanced Error Parsing (`open-sse/utils/error.js`)

Added `parseRateLimitResetFromHeaders()` function to extract reset times from headers:

```javascript
export function parseRateLimitResetFromHeaders(headers) {
  // Priority order:
  // 1. x-ratelimit-reset-tokens (most relevant for quota)
  // 2. x-ratelimit-reset-requests
  // 3. retry-after (standard header)
  // 4. x-ratelimit-reset (Unix timestamp)
  
  // Returns: milliseconds until reset, or null if not found
}
```

Updated `parseUpstreamError()` to extract `retryAfterMs` from headers:

```javascript
export async function parseUpstreamError(response, provider = null) {
  // ... parse error message ...
  
  // Extract actual reset time from headers
  retryAfterMs = parseRateLimitResetFromHeaders(response.headers);
  
  return {
    statusCode: response.status,
    message: finalMessage,
    retryAfterMs  // ← Now includes actual reset time
  };
}
```

### 2. Updated Error Detection (`open-sse/services/accountFallback.js`)

Modified `checkFallbackError()` to accept and use `retryAfterMs`:

```javascript
export function checkFallbackError(status, errorText, backoffLevel = 0, retryAfterMs = null) {
  // Check for quota exhaustion
  if (isQuotaExhaustedError(errorStr)) {
    // Use actual reset time from headers if available, otherwise fallback to 6 hours
    const cooldown = retryAfterMs || COOLDOWN_MS.quotaExhausted;
    return {
      shouldFallback: true,
      cooldownMs: cooldown,
      newBackoffLevel: 0
    };
  }
  
  // For rate limits, also prefer actual reset time
  if (lowerError.includes("rate limit")) {
    if (retryAfterMs) {
      return {
        shouldFallback: true,
        cooldownMs: retryAfterMs,
        newBackoffLevel: 0  // Reset since we have exact time
      };
    }
    // Fallback to exponential backoff if no header
    // ...
  }
}
```

### 3. Updated Auth Service (`src/sse/services/auth.js`)

Modified `markAccountUnavailable()` to accept `retryAfterMs`:

```javascript
export async function markAccountUnavailable(
  connectionId, 
  status, 
  errorText, 
  provider = null, 
  model = null, 
  retryAfterMs = null  // ← New parameter
) {
  const { shouldFallback, cooldownMs, newBackoffLevel } = 
    checkFallbackError(status, errorText, backoffLevel, retryAfterMs);
  // ... rest of function
}
```

### 4. Updated Request Handlers

**Chat Handler** (`src/sse/handlers/chat.js`):
```javascript
const { shouldFallback } = await markAccountUnavailable(
  credentials.connectionId, 
  result.status, 
  result.error, 
  provider, 
  model, 
  result.retryAfterMs  // ← Pass actual reset time
);
```

**Embeddings Handler** (`src/sse/handlers/embeddings.js`):
```javascript
const { shouldFallback } = await markAccountUnavailable(
  credentials.connectionId, 
  result.status, 
  result.error, 
  provider, 
  model, 
  result.retryAfterMs  // ← Pass actual reset time
);
```

## OpenAI Rate Limit Headers

OpenAI returns these headers on rate limit/quota errors:

| Header | Description | Example |
|--------|-------------|---------|
| `x-ratelimit-reset-tokens` | When token quota resets (RFC3339) | `2026-04-14T17:45:00Z` |
| `x-ratelimit-reset-requests` | When request quota resets (RFC3339) | `2026-04-14T17:45:00Z` |
| `x-ratelimit-remaining-tokens` | Remaining tokens in quota | `0` |
| `x-ratelimit-remaining-requests` | Remaining requests in quota | `0` |
| `retry-after` | Standard retry header (seconds or date) | `18000` |

## How It Works

### Flow Diagram

```
1. Request to OpenAI fails with 403/429
   ↓
2. parseUpstreamError() extracts:
   - Error message: "You exceeded your current quota"
   - Reset time from headers: "2026-04-14T17:45:00Z"
   - Calculates retryAfterMs: 18000000 (5 hours)
   ↓
3. markAccountUnavailable() receives retryAfterMs
   ↓
4. checkFallbackError() detects quota exhaustion
   - Uses actual retryAfterMs (5 hours) instead of guessing 6 hours
   ↓
5. Account locked until exact reset time
   ↓
6. System falls back to next available account
   ↓
7. User sees accurate message: "reset after 5h"
```

### Example Scenarios

**Scenario 1: Quota exhausted with header**
- Error: "You exceeded your current quota"
- Header: `x-ratelimit-reset-tokens: 2026-04-14T17:45:00Z`
- Current time: `2026-04-14T12:45:00Z`
- **Cooldown: 5 hours (exact)** ✅

**Scenario 2: Quota exhausted without header**
- Error: "You exceeded your current quota"
- Header: (missing)
- **Cooldown: 6 hours (fallback)** ✅

**Scenario 3: Temporary rate limit with header**
- Error: "Rate limit exceeded"
- Header: `retry-after: 30`
- **Cooldown: 30 seconds (exact)** ✅

**Scenario 4: Temporary rate limit without header**
- Error: "Rate limit exceeded"
- Header: (missing)
- **Cooldown: 1s → 2s → 4s... (exponential backoff)** ✅

## Test Results

All 6 test cases passed:

| Test Case | Status | Error | Header | Expected | Result |
|-----------|--------|-------|--------|----------|--------|
| Quota with 5h header | 403 | "exceeded quota" | 5h | 5h | ✅ PASS |
| Quota with 2h header | 429 | "exceeded quota" | 2h | 2h | ✅ PASS |
| Quota without header | 403 | "exceeded quota" | none | 6h | ✅ PASS |
| Rate limit with 30s header | 429 | "rate limit" | 30s | 30s | ✅ PASS |
| Rate limit without header | 429 | "rate limit" | none | 1s | ✅ PASS |
| Insufficient quota with header | 403 | "insufficient_quota" | 5h | 5h | ✅ PASS |

## Benefits

### Before Fix
- ❌ Used fixed 6-hour guess for all quota errors
- ❌ Ignored actual reset time from OpenAI headers
- ❌ Could lock accounts too long or too short
- ❌ Inaccurate retry timing displayed to users

### After Fix
- ✅ Uses **actual reset time from OpenAI headers**
- ✅ Precise cooldown matching OpenAI's quota window
- ✅ Falls back to 6 hours only if header missing
- ✅ Accurate retry timing displayed to users
- ✅ Works for both 5-hour rolling window and weekly quotas
- ✅ Also improves temporary rate limit handling

## Files Modified

1. **open-sse/utils/error.js**
   - Added `parseRateLimitResetFromHeaders()`
   - Updated `parseUpstreamError()` to extract `retryAfterMs`

2. **open-sse/services/accountFallback.js**
   - Updated `checkFallbackError()` to accept `retryAfterMs` parameter
   - Uses actual reset time when available, fallback to 6h otherwise

3. **open-sse/config/runtimeConfig.js**
   - Added `quotaExhausted: 6 * 60 * 60 * 1000` (6h fallback)

4. **src/sse/services/auth.js**
   - Updated `markAccountUnavailable()` to accept `retryAfterMs`
   - Passes `retryAfterMs` to `checkFallbackError()`

5. **src/sse/handlers/chat.js**
   - Passes `result.retryAfterMs` to `markAccountUnavailable()`

6. **src/sse/handlers/embeddings.js**
   - Passes `result.retryAfterMs` to `markAccountUnavailable()`

## Backward Compatibility

✅ Fully backward compatible:
- If headers are missing, falls back to 6-hour cooldown
- If `retryAfterMs` is null, uses existing logic
- Works with all providers (OpenAI, Codex, Antigravity, etc.)
- No breaking changes to existing APIs

## Next Steps

1. ✅ Deploy to production
2. Monitor Codex account behavior with actual reset times
3. Verify accurate cooldown durations in logs
4. Check UI displays correct retry timing from headers
5. Consider adding similar header parsing for other providers

## Notes

- OpenAI's 5-hour rolling window quota now uses exact reset time
- Weekly quotas will also use exact reset time if provided in headers
- The 6-hour fallback is only used when headers are missing
- This fix also improves temporary rate limit handling with exact retry times
- Works for all OpenAI models including GPT-4, GPT-5, Codex, etc.

---

**Summary:** Instead of guessing 6 hours, we now use the **actual quota reset time from OpenAI's response headers**, providing precise cooldown periods and better user experience.
