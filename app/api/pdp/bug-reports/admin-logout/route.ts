import { NextResponse } from "next/server";
import { PDP_BUG_REPORT_ADMIN_COOKIE } from "../../../../../lib/pdp-server/pdp-bug-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A cookie is only deleted when the clearing Set-Cookie matches its Path.
// Current logins issue the cookie at "/"; logins from before the path fix
// used "/pdp-maker/admin". Expire both so logout works for everyone,
// including sessions started before the fix was deployed.
const SESSION_COOKIE_PATHS = ["/", "/pdp-maker/admin"];

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/pdp-maker/admin/bug-reports", request.url), { status: 303 });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  for (const path of SESSION_COOKIE_PATHS) {
    response.headers.append(
      "set-cookie",
      `${PDP_BUG_REPORT_ADMIN_COOKIE}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`
    );
  }

  return response;
}
