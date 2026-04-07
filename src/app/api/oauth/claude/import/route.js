import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/claude/import
 * Import Claude Code credentials directly (from Claude Code's OAuth token store)
 *
 * Request body (wrapped format):
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "sk-ant-oat01-...",
 *     "refreshToken": "sk-ant-ort01-...",
 *     "expiresAt": 1775563674691,
 *     "scopes": ["user:inference", ...],
 *     "subscriptionType": "pro",
 *     "rateLimitTier": "default_claude_ai"
 *   }
 * }
 *
 * Also accepts unwrapped format (just the inner object directly).
 */
export async function POST(request) {
  try {
    const body = await request.json();

    // Support both wrapped { claudeAiOauth: { ... } } and unwrapped { accessToken, ... }
    const oauthData = body.claudeAiOauth || body;

    if (!oauthData.accessToken || typeof oauthData.accessToken !== "string") {
      return NextResponse.json(
        { error: "Missing accessToken" },
        { status: 400 }
      );
    }

    if (!oauthData.refreshToken || typeof oauthData.refreshToken !== "string") {
      return NextResponse.json(
        { error: "Missing refreshToken" },
        { status: 400 }
      );
    }

    // Convert expiresAt from epoch ms to ISO string
    let expiresAt = null;
    if (oauthData.expiresAt) {
      expiresAt = new Date(oauthData.expiresAt).toISOString();
    }

    // Build provider-specific data
    const providerSpecificData = {
      authMethod: "imported",
      provider: "Imported",
    };
    if (oauthData.subscriptionType) providerSpecificData.subscriptionType = oauthData.subscriptionType;
    if (oauthData.rateLimitTier) providerSpecificData.rateLimitTier = oauthData.rateLimitTier;
    if (Array.isArray(oauthData.scopes)) providerSpecificData.scopes = oauthData.scopes;

    // Build a display name from subscription type
    const displayName = oauthData.subscriptionType
      ? `Claude ${oauthData.subscriptionType.charAt(0).toUpperCase() + oauthData.subscriptionType.slice(1)}`
      : null;

    // Save to database
    const connection = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      accessToken: oauthData.accessToken,
      refreshToken: oauthData.refreshToken,
      expiresAt,
      scope: Array.isArray(oauthData.scopes) ? oauthData.scopes.join(" ") : null,
      displayName,
      testStatus: "active",
      providerSpecificData,
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Claude import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
