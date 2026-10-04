import path from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"

// The site lives next to another bun project (the spec-manager CLI); pin the
// Turbopack root to this directory so the site's own lockfile is used.
const root = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  turbopack: {
    root,
  },
  // Next blocks cross-origin requests to dev assets (including the HMR
  // websocket) unless the origin is on this allowlist; the site is opened
  // via 127.0.0.1, which is not allowed by default, so allow it or the dev
  // client never connects and the page never renders.
  allowedDevOrigins: ["127.0.0.1"],
}

export default nextConfig
