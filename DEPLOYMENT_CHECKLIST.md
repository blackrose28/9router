# Codex Quota Fix - Deployment Checklist

**Date:** 2026-04-14  
**Status:** ✅ Ready for Deployment

## Pre-Deployment Verification

- [x] All 6 files modified and syntax validated
- [x] All 6 test cases passed
- [x] Integration points verified
- [x] Backward compatibility confirmed
- [x] Documentation complete

## Modified Files

1. [x] `open-sse/utils/error.js` - Added header parsing
2. [x] `open-sse/services/accountFallback.js` - Updated error detection
3. [x] `open-sse/config/runtimeConfig.js` - Added quotaExhausted constant
4. [x] `src/sse/services/auth.js` - Updated markAccountUnavailable
5. [x] `src/sse/handlers/chat.js` - Pass retryAfterMs
6. [x] `src/sse/handlers/embeddings.js` - Pass retryAfterMs

## Backup Files

- [x] `open-sse/services/accountFallback.js.backup` - Created

## Deployment Steps

### 1. Pre-Deployment
- [ ] Review all changes in staging environment
- [ ] Verify no conflicts with other pending changes
- [ ] Notify team about deployment

### 2. Deployment
- [ ] Deploy to production
- [ ] Monitor error logs for any issues
- [ ] Check first quota error is handled correctly

### 3. Post-Deployment Monitoring

**First 24 Hours:**
- [ ] Monitor Codex account locks in logs
- [ ] Verify actual reset times are being used (not 6h fallback)
- [ ] Check user-facing retry messages show correct times
- [ ] Confirm no repeated failed requests to quota-exhausted accounts

**Look for in logs:**
```
✓ Good: "locked modelLock_gpt-5.3-codex for 18234s [403]" (exact time from header)
✗ Bad: "locked modelLock_gpt-5.3-codex for 21600s [403]" (6h fallback, means headers missing)
```

**First Week:**
- [ ] Verify 5-hour rolling window quotas reset correctly
- [ ] Check weekly quotas also use correct reset times
- [ ] Monitor for any edge cases or unexpected behavior
- [ ] Gather user feedback on retry timing accuracy

### 4. Success Metrics

- [ ] Zero repeated requests to quota-exhausted accounts
- [ ] Accurate retry timing displayed to users
- [ ] Logs show actual reset times being used (not 6h fallback)
- [ ] No increase in error rates or failed requests

## Rollback Plan

If issues occur:

1. **Immediate Rollback:**
   ```bash
   cp open-sse/services/accountFallback.js.backup open-sse/services/accountFallback.js
   git checkout open-sse/utils/error.js
   git checkout open-sse/config/runtimeConfig.js
   git checkout src/sse/services/auth.js
   git checkout src/sse/handlers/chat.js
   git checkout src/sse/handlers/embeddings.js
   ```

2. **Restart services**

3. **Monitor for stability**

## Expected Behavior After Deployment

### Scenario 1: Quota Exhausted with Header
```
Request → 403 "exceeded your current quota"
Header: x-ratelimit-reset-tokens: 2026-04-14T17:45:00Z
Current: 2026-04-14T12:45:00Z
Result: Account locked for 5h (18000000ms) ✓
```

### Scenario 2: Quota Exhausted without Header
```
Request → 403 "exceeded your current quota"
Header: (missing)
Result: Account locked for 6h (21600000ms) - fallback ✓
```

### Scenario 3: Temporary Rate Limit
```
Request → 429 "rate limit exceeded"
Header: retry-after: 30
Result: Account locked for 30s (30000ms) ✓
```

## Troubleshooting

### Issue: All accounts still using 6h fallback
**Cause:** Headers not being parsed correctly  
**Check:** Verify `parseRateLimitResetFromHeaders()` is being called  
**Fix:** Check OpenAI response headers format

### Issue: Accounts locked too long/short
**Cause:** Incorrect time calculation  
**Check:** Verify timezone handling in date parsing  
**Fix:** Review `parseRateLimitResetFromHeaders()` date parsing

### Issue: Repeated failed requests still occurring
**Cause:** Account not being marked unavailable  
**Check:** Verify `markAccountUnavailable()` is being called with retryAfterMs  
**Fix:** Check error flow in chat/embeddings handlers

## Contact

For issues or questions:
- Check logs: Look for "TOKEN_REFRESH" and "AUTH" log entries
- Review documentation: `CODEX_QUOTA_FIX_FINAL.md`
- Test locally: Run test suite to verify behavior

## Sign-off

- [ ] Code reviewed
- [ ] Tests passed
- [ ] Documentation complete
- [ ] Deployment approved
- [ ] Team notified

---

**Deployment Date:** _____________  
**Deployed By:** _____________  
**Verified By:** _____________  

