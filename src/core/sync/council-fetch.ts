import type { Logger } from "@/utils/logger/index.ts";
import { getCouncilPlatformUrl } from "@/config/env.ts";
import type { CouncilTopologyEntry } from "@/core/events/types.ts";
import { StructuredError } from "@/error/structured-error.ts";

const SOURCE = "network-dashboard-platform/council-fetch";

/**
 * Shape of the upstream `GET /api/v1/public/councils` response. Mirrors
 * council-platform's serializer. We only depend on the fields used to
 * build the dashboard topology — extra fields are ignored gracefully.
 */
type PublicCouncil = {
  council?: { name?: string | null; channelAuthId?: string };
  jurisdictions?: Array<{ countryCode?: string }>;
  channels?: Array<{
    channelContractId?: string;
    assetCode?: string;
    assetContractId?: string | null;
  }>;
  providers?: Array<{
    publicKey?: string;
    label?: string | null;
    providerUrl?: string | null;
  }>;
};

type PublicCouncilsResponse = { data?: PublicCouncil[] };

export async function fetchCouncilTopology(
  deps: { log: Logger },
): Promise<CouncilTopologyEntry[]> {
  const log = deps.log.scope("fetchCouncilTopology");
  log.info("fetchCouncilTopology");

  const base = getCouncilPlatformUrl().replace(/\/+$/, "");
  const url = `${base}/api/v1/public/councils`;
  log.debug("url", url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    log.event("requesting council list");
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      // Network failure / timeout abort — wrap with context, preserving the
      // underlying cause so the log chain shows the transport error.
      throw StructuredError.from(err, {
        code: "COUNCIL_PLATFORM_UNREACHABLE",
        source: SOURCE,
        message: "council-platform request failed",
      });
    }
    if (!res.ok) {
      throw new StructuredError({
        code: "COUNCIL_PLATFORM_HTTP_ERROR",
        source: SOURCE,
        message: `council-platform returned HTTP ${res.status}`,
      });
    }
    log.event("council list received");
    const body = (await res.json()) as PublicCouncilsResponse;
    const entries: CouncilTopologyEntry[] = [];
    for (const c of body.data ?? []) {
      const id = c.council?.channelAuthId;
      if (!id) continue;
      entries.push({
        id,
        name: c.council?.name ?? null,
        providers: (c.providers ?? [])
          .flatMap((p) =>
            p.publicKey
              ? [{
                publicKey: p.publicKey,
                label: p.label ?? null,
                providerUrl: p.providerUrl ?? null,
              }]
              : []
          ),
        channels: (c.channels ?? [])
          .flatMap((ch) =>
            ch.channelContractId
              ? [{
                contractId: ch.channelContractId,
                assetCode: ch.assetCode ?? "",
                assetContractId: ch.assetContractId ?? null,
              }]
              : []
          ),
        jurisdictions: (c.jurisdictions ?? [])
          .map((j) => j.countryCode)
          .filter((code): code is string => !!code),
      });
    }
    log.debug("count", entries.length);
    log.event("council-platform topology built");
    return entries;
  } finally {
    clearTimeout(timer);
  }
}
