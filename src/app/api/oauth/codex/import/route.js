import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/codex/import
 * Import Codex credentials from auth.json (usually ~/.codex/auth.json)
 *
 * Request body: the full auth.json content
 * {
 *   auth_mode: "chatgpt" | "apikey",
 *   OPENAI_API_KEY: string | null,
 *   tokens: { id_token, access_token, refresh_token, account_id },
 *   last_refresh: string
 * }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { tokens, auth_mode, OPENAI_API_KEY } = body;

    if (!tokens || typeof tokens !== "object") {
      return NextResponse.json(
        { error: "Missing tokens object" },
        { status: 400 }
      );
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      return NextResponse.json(
        { error: "Missing access_token or refresh_token in tokens" },
        { status: 400 }
      );
    }

    // Decode id_token JWT payload to extract email & display name
    let email = null;
    let displayName = null;
    if (tokens.id_token) {
      try {
        const parts = tokens.id_token.split(".");
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf-8")
        );
        email = payload.email || null;
        displayName = payload.name || null;
      } catch {
        // id_token decode failed — continue without user info
      }
    }

    // Extract expiry from access_token JWT
    let expiresAt = null;
    try {
      const parts = tokens.access_token.split(".");
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf-8")
      );
      if (payload.exp) {
        expiresAt = new Date(payload.exp * 1000).toISOString();
      }
    } catch {
      // access_token decode failed
    }

    // Build provider-specific data
    const providerSpecificData = {
      authMethod: "imported",
      provider: "Imported",
    };
    if (tokens.account_id) providerSpecificData.accountId = tokens.account_id;
    if (auth_mode) providerSpecificData.authMode = auth_mode;
    if (OPENAI_API_KEY) providerSpecificData.apiKey = OPENAI_API_KEY;

    // Save to database
    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token || null,
      email,
      displayName,
      expiresAt,
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
    console.log("Codex import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
