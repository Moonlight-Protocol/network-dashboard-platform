import { LOG } from "@/config/logger.ts";

/**
 * Registry of accepted Channel Auth WASM hashes.
 *
 * The new-council listener in `contract-init-listener.ts` only adopts a
 * contract whose on-chain `wasm_hash` is in this set — anything else gets
 * cached as not-Moonlight and ignored. The set is populated by fetching
 * the `channel_auth_contract.wasm` artifact from each soroban-core
 * release on GitHub and computing its SHA-256.
 *
 * Why GitHub releases (not env or council-platform):
 *   - Same source `setup-c.sh` / `setup-c.ts` download from when deploying
 *     a new council, so hashes match by construction.
 *   - Authoritative + version-stable (older releases keep their tag), so
 *     new soroban-core releases self-register without redeploying the
 *     dashboard backend.
 *   - No `.env` to keep in sync; no hash to hardcode per environment.
 *
 * Bootstrap: at startup we fetch once. If GitHub is unreachable the set
 * stays empty and the listener becomes a no-op (council discovery falls
 * back to the hourly topology resync). The hourly scheduler calls
 * `refreshWasmRegistry()` again so an outage at boot self-heals.
 */

const RELEASES_REPO = (Deno.env.get("CHANNEL_AUTH_WASM_REPO") ??
  "Moonlight-Protocol/soroban-core").trim();
const RELEASES_URL =
  `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=50`;
const TARGET_ASSET = "channel_auth_contract.wasm";

const validHashes = new Set<string>();
let lastRefreshOk = false;

export function isKnownChannelAuthHash(hash: string): boolean {
  return validHashes.has(hash.toLowerCase());
}

export function knownHashCount(): number {
  return validHashes.size;
}

export function isReady(): boolean {
  return validHashes.size > 0;
}

/** Test-only seam. */
export function __resetForTests(): void {
  validHashes.clear();
  lastRefreshOk = false;
}

/**
 * Fetch the soroban-core release list, download each release's
 * channel_auth_contract.wasm asset, and merge its SHA-256 into the
 * accepted-hash set. Idempotent and additive — hashes from previous
 * refreshes are kept so deploys against older council versions remain
 * recognised even if GitHub temporarily omits an old release.
 */
export async function refreshWasmRegistry(): Promise<void> {
  let releases: Array<
    {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    }
  >;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { "Accept": "application/vnd.github+json" },
    });
    if (!res.ok) {
      LOG.warn("Channel Auth WASM registry fetch failed", {
        repo: RELEASES_REPO,
        status: res.status,
      });
      return;
    }
    releases = await res.json();
  } catch (err) {
    LOG.warn("Channel Auth WASM registry fetch threw", {
      repo: RELEASES_REPO,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const beforeCount = validHashes.size;
  for (const r of releases) {
    const asset = r.assets.find((a) => a.name === TARGET_ASSET);
    if (!asset) continue;
    try {
      const dl = await fetch(asset.browser_download_url);
      if (!dl.ok) {
        LOG.warn("Channel Auth WASM download failed", {
          tag: r.tag_name,
          status: dl.status,
        });
        continue;
      }
      const buf = await dl.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (!validHashes.has(hash)) {
        validHashes.add(hash);
        LOG.info("Channel Auth WASM registered", {
          tag: r.tag_name,
          wasmHash: hash,
          bytes: buf.byteLength,
        });
      }
    } catch (err) {
      LOG.warn("Channel Auth WASM probe threw", {
        tag: r.tag_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  lastRefreshOk = validHashes.size > 0;
  LOG.info("Channel Auth WASM registry refreshed", {
    repo: RELEASES_REPO,
    totalReleases: releases.length,
    knownHashes: validHashes.size,
    addedSinceLast: validHashes.size - beforeCount,
  });
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { lastRefreshOk };
