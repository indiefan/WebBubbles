import { execFile } from "child_process";
import { NextResponse } from "next/server";

// Local-development sign-in. Hands the BlueBubbles server URL and password,
// stored in the macOS login keychain by scripts/dev-login.sh, to the dev build
// so it can sign itself in.
//
// Only answers when started through `npm run dev`, which sets BB_DEV_SESSION
// and binds the dev server to loopback. Every other build returns 404.

const KEYCHAIN_SERVICE = "webbubbles-dev";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function notFound() {
  return NextResponse.json({ status: 404, message: "Not found" }, { status: 404 });
}

function readKeychain(account: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? null : stdout.replace(/\r?\n$/, "")),
    );
  });
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development" || process.env.BB_DEV_SESSION !== "1") {
    return notFound();
  }

  // Refuse anything that isn't the app itself calling over loopback
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(host)) return notFound();
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return notFound();

  // An explicit server in the environment (e.g. the fake one) wins over the keychain
  const fromEnv = process.env.BB_DEV_SERVER_URL && process.env.BB_DEV_PASSWORD;
  const [serverUrl, password] = fromEnv
    ? [process.env.BB_DEV_SERVER_URL, process.env.BB_DEV_PASSWORD]
    : await Promise.all([readKeychain("server-url"), readKeychain("password")]);
  if (!serverUrl || !password) return notFound();

  return NextResponse.json(
    { serverUrl, password },
    { headers: { "Cache-Control": "no-store" } },
  );
}
