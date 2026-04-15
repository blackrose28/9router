# Codex Quota Exhaustion Fix

**Date:** 2026-04-14  
**Status:** ✅ Complete and Tested

## Problem Statement

When Codex (OpenAI) accounts hit quota limits (5-hour rolling window or weekly quota), the system was treating them as temporary rate limits with exponential backoff starting at 1 second, causing repeated failed requests every few minutes.

## Root Cause

The error detection logic in `accountFallback.js` was treating all "quota exceeded" errors the same as rate limits, using short cooldowns (1-2 minutes max) instead of recognizing quota exhaustion which requires hours of cooldown.

## Solution

### 1. Configuration Update (`open-sse/config/runtimeConfig.js`)

Added new cooldown constant for quota exhaustion:

```javascript
export const COOLDOWN_MS = {
  unauthorized: 2 * 60 * 1000,
  paymentRequired: 2 * 60 * 1000,
  notFound: 2 * 60 * 1000,
  transient: 30 * 1000,
  requestNotAllowed: 5 * 1000,
  quotaExhausted: 6 * 60 * 60 * 1000,  // 6 hours (covers 5h rolling window + buffer)
  // Legacy aliases
  rateLimit: 2 * 60 * 1000,
  serviceUnavailable: 2 * 1000,
  authExpired: 2 * 60 * 1000
};
```

### 2. Error Detection Logic (`open-sse/services/accountFallback.js`)

Added quota exhaustion detection function:

```javascript
function isQuotaExhaustedError(errorText) {
  if (!errorText) return false;
  const lowerError = typeof errorText === "string" 
    ? errorText.toLowerCase() 
    : JSON.stringify(errorText).toLowerCase();
  
  // OpenAI/Codex specific quota exhaustion patterns
  return (
    lowerError.includes("exceeded your current quota") ||
    lowerError.includes("insufficient_quota") ||
    lowerError.includes("billing details") ||
    lowerError.includes("quota has been exceeded") ||
    lowerError.includes("usage limit")
  );
}
```

Updated `checkFallbackError()` to check quota exhaustion BEFORE rate limits:

```javascript
// Check for quota exhaustion BEFORE general rate limit check
if (isQuotaExhaustedError(errorStr)) {
  return {
    shouldFallback: true,
    cooldownMs: COOLDOWN_MS.quotaExhausted,
    newBackoffLevel: 0  // Reset backoff level
  };
}

// Rate limit keywords - exponential backoff (for temporary rate limits)
if (
  lowerError.includes("rate limit") ||
  lowerError.includes("too many requests") ||
  lowerError.includes("capacity") ||
  lowerError.includes("overloaded")
) {
  const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
  return {
    shouldFallback: true,
    cooldownMs: getQuotaCooldown(backoffLevel),
    newBackoffLevel: newLevel
  };
}
```

Enhanced status code handling for 403 and 429:

```javascript
// 403 Forbidden - check if it's quota exhaustion
if (status === HTTP_STATUS.FORBIDDEN) {
  if (isQuotaExhaustedError(errorText)) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.quotaExhausted };
  }
  return { shouldFallback: true, cooldownMs: COOLDOWN_MS.paymentRequired };
}

// 429 - Rate limit - check if it's quota exhaustion or temporary rate limit
if (status === HTTP_STATUS.RATE_LIMITED) {
  if (isQuotaExhaustedError(errorText)) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.quotaExhausted };
  }
  // Exponential backoff for temporary rate limits
  const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
  return {
    shouldFallback: true,
    cooldownMs: getQuotaCooldown(backoffLevel),
    newBackoffLevel: newLevel
  };
}
```

## Test Results

All 6 test cases passed:

| Test Case | Status Code | Error Message | Expected Cooldown | Result |
|-----------|-------------|---------------|-------------------|--------|
| OpenAI quota exhausted | 403 | "You exceeded your current quota..." | 6 hours | ✅ PASS |
| OpenAI quota exhausted | 429 | "You exceeded your current quota" | 6 hours | ✅ PASS |
| Insufficient quota | 403 | "insufficient_quota" | 6 hours | ✅ PASS |
| Temporary rate limit | 429 | "Rate limit exceeded..." | 1 second | ✅ PASS |
| Too many requests | 429 | "Too many requests" | 1 second | ✅ PASS |
| Server overloaded | 429 | "Server is currently overloaded" | 1 second | ✅ PASS |

## Behavior Comparison

### Before Fix
- ❌ Codex quota exhaustion treated as rate limit
- ❌ Account locked for 1-2 minutes (exponential backoff)
- ❌ Repeated failed requests every few minutes
- ❌ Poor user experience
- ❌ Wasted API calls

### After Fix
- ✅ Codex quota exhaustion detected by error message
- ✅ Account locked for 6 hours
- ✅ System falls back to other accounts immediately
- ✅ No repeated failed requests
- ✅ Clear retry timing displayed to user
- ✅ Better resource utilization

## How It Works

1. **Request fails** with 403/429 status code
2. **Error message is analyzed** by `isQuotaExhaustedError()`
3. **If quota exhaustion detected:**
   - Account is locked for 6 hours via `modelLock_${model}` field
   - System immediately tries next available account
   - User sees "reset after 6h" message
4. **If temporary rate limit detected:**
   - Account uses exponential backoff (1s → 2s → 4s → ... → 2min max)
   - System tries next available account
   - User sees "reset after Xs" message

## Files Modified

- `open-sse/config/runtimeConfig.js` - Added `quotaExhausted` constant
- `open-sse/services/accountFallback.js` - Added detection logic and enhanced error handling

## Backup

Backup created at: `open-sse/services/accountFallback.js.backup`

## Next Steps

1. Deploy to production
2. Monitor Codex account behavior
3. Verify 6-hour locks are applied correctly
4. Confirm no repeated failed requests
5. Adjust cooldown duration if needed based on real-world data

## Notes

- The 6-hour cooldown covers OpenAI's 5-hour rolling window quota plus 1-hour buffer
- Weekly quota limits will also be blocked for 6 hours (may need adjustment in future)
- The fix applies to all OpenAI/Codex error patterns, not just specific status codes
- Temporary rate limits still use exponential backoff for optimal retry behavior
