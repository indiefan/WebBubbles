import type { NextConfig } from "next";
import { execSync } from "child_process";

// Version is read from package.json at build time
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("./package.json");

// Get commit hash: prefer APP_VERSION env (set by Docker/CI), fall back to git
let commitHash = process.env.APP_VERSION || "";
if (!commitHash) {
  try {
    commitHash = execSync("git rev-parse --short=7 HEAD").toString().trim();
  } catch {
    commitHash = "dev";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: `${pkg.version}.${commitHash}`,
  },
};

export default nextConfig;
