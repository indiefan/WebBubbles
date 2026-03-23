import type { NextConfig } from "next";
import { execSync } from "child_process";

let commitHash = "dev";
try {
  commitHash = execSync("git rev-parse HEAD").toString().trim();
} catch {}

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_COMMIT_HASH: commitHash,
  },
};

export default nextConfig;
