import { loadConfig, type AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { flattenFixtures, normalizeBooking } from "./normalizers.js";
import type { RawBookingResponse, RawUpcomingResponse } from "./rawTypes.js";
import type { SportyBetBooking, SportyBetFixture, SportyBetSelection } from "./types.js";
import { resolveSport } from "./marketCatalogue.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SportyBetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly action?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SportyBetError";
  }
}

export interface FixturesRequest {
  sport?: string;
  marketIds?: string[];
  timelineHours?: number;
  pageSize?: number;
  maxPages?: number;
}

const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 5;
const DEFAULT_TIMELINE_HOURS = 720;
const MULTI_SPORT_LIST = ["football", "basketball", "tennis"];

export class SportyBetClient {
  private lastRequestAt = 0;
  private inflight = 0;
  private readonly cache = new Map<string, { at: number; fixtures: SportyBetFixture[] }>();

  constructor(private readonly cfg: AppConfig = loadConfig()) {}

  private get baseUrl(): string {
    return `${this.cfg.apiBaseUrl}/api/${this.cfg.region}`;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Current-Country": this.cfg.region.toUpperCase(),
    };
  }

  private async acquireSlot(): Promise<void> {
    for (;;) {
      const wait = this.lastRequestAt + this.cfg.minRequestIntervalMs - Date.now();
      if (this.inflight < this.cfg.maxConcurrentRequests && wait <= 0) {
        this.lastRequestAt = Date.now();
        this.inflight++;
        return;
      }
      await sleep(Math.max(wait, 25));
    }
  }

  private releaseSlot(): void {
    this.inflight--;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { retry?: boolean } = {},
  ): Promise<T> {
    const { retry = true, ...rest } = init;
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = this.cfg.timeoutMs;
    let attempts = 0;
    const maxAttempts = retry ? Math.max(1, this.cfg.maxRetries + 1) : 1;

    for (;;) {
      attempts++;
      await this.acquireSlot();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(url, { ...rest, headers: this.headers(), signal: controller.signal });
        const text = await res.text();
        const latencyMs = Date.now() - started;

        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }

        if (!res.ok) {
          const status = res.status;
          logger.warn({
            request: rest.method ?? "GET",
            status,
            latencyMs,
            retry: attempts < maxAttempts,
          });
          const retryable = status === 429 || status >= 500;
          if (retryable && attempts < maxAttempts) {
            await this.backoff(attempts, status);
            continue;
          }
          throw this.httpError(status, body);
        }

        logger.debug({ request: rest.method ?? "GET", status: res.status, latencyMs });
        if (body === null) {
          const errMsg = `SportyBet returned an empty or unparseable response (HTTP ${res.status}).`;
          if (retry && attempts < maxAttempts) {
            logger.warn({ message: errMsg, retry: true, latencyMs });
            await this.backoff(attempts, res.status);
            continue;
          }
          throw new SportyBetError("MALFORMED_RESPONSE", errMsg, "Try again later; the upstream API may be misbehaving.", true);
        }
        return body as T;
      } catch (err) {
        const latencyMs = Date.now() - started;
        if (err instanceof SportyBetError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          if (attempts < maxAttempts) {
            logger.warn({ message: `request timed out after ${timeoutMs}ms`, retry: true, latencyMs });
            await this.backoff(attempts, 0);
            continue;
          }
          throw new SportyBetError(
            "TIMEOUT",
            `SportyBet request timed out after ${timeoutMs}ms.`,
            "Check your network connection and try again.",
            true,
          );
        }
        const networkError = err instanceof Error ? err.message : String(err);
        if (attempts < maxAttempts) {
          logger.warn({ message: `network error: ${networkError}`, retry: true, latencyMs });
          await this.backoff(attempts, 0);
          continue;
        }
        throw new SportyBetError(
          "NETWORK",
          `Could not reach SportyBet: ${networkError}`,
          "Check your network connection and try again.",
          true,
        );
      } finally {
        clearTimeout(timer);
        this.releaseSlot();
      }
    }
  }

  private async backoff(attempt: number, status: number): Promise<void> {
    const base = 500 * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    const wait = status === 429 ? base * 2 : base;
    logger.debug({ message: `backing off ${wait + jitter}ms (attempt ${attempt})` });
    await sleep(wait + jitter);
  }

  private httpError(status: number, body: unknown): SportyBetError {
    const message = this.messageFrom(body);
    switch (status) {
      case 400:
        return new SportyBetError("BAD_REQUEST", message ?? "SportyBet rejected the request (HTTP 400).", "Check the request parameters and retry.");
      case 401:
        return new SportyBetError("UNAUTHORIZED", message ?? "SportyBet requires authentication (HTTP 401).", "No credentials are configured for this server; check whether the endpoint now requires a key.");
      case 403:
        return new SportyBetError("FORBIDDEN", message ?? "SportyBet refused the request (HTTP 403).", "The endpoint may have changed or the region is blocked.");
      case 404:
        return new SportyBetError("NOT_FOUND", message ?? "SportyBet endpoint not found (HTTP 404).", "The API path may have changed; see README 'API source'.");
      case 429:
        return new SportyBetError("RATE_LIMITED", message ?? "SportyBet rate limit reached (HTTP 429).", "Wait a moment and retry with fewer requests.");
      default:
        return new SportyBetError("SERVER_ERROR", message ?? `SportyBet returned HTTP ${status}.`, "Retry later; if it persists the upstream API may be down.", true);
    }
  }

  private messageFrom(body: unknown): string | null {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.message === "string") return b.message;
      if (typeof b.error === "string") return b.error;
    }
    return null;
  }

  private bizError(body: unknown): SportyBetError | null {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const bizCode = Number(b.bizCode);
      if (bizCode && bizCode !== 10000) {
        const msg = typeof b.message === "string" ? b.message : `bizCode ${bizCode}`;
        return new SportyBetError("UPSTREAM", `SportyBet rejected request: ${msg}`, "Verify inputs and try again.");
      }
    }
    return null;
  }

  async getFixtures(req: FixturesRequest = {}): Promise<SportyBetFixture[]> {
    if (req.sport?.trim().toLowerCase() === "all") {
      const results = await Promise.all(
        MULTI_SPORT_LIST.map((s) => this.getFixtures({ ...req, sport: s })),
      );
      return results.flat();
    }

    const sportCfg = resolveSport(req.sport);
    const marketIds = req.marketIds?.length ? req.marketIds : sportCfg.defaultMarketIds;
    const timelineHours = Math.min(Math.max(req.timelineHours ?? DEFAULT_TIMELINE_HOURS, 1), 720);
    const pageSize = Math.min(Math.max(req.pageSize ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const maxPages = Math.min(Math.max(req.maxPages ?? MAX_PAGES, 1), 10);

    const cacheKey = `${sportCfg.id}:${marketIds.join(",")}:${timelineHours}:${maxPages}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.cfg.cacheTtlMs) {
      return hit.fixtures;
    }

    const collected: SportyBetFixture[] = [];
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const params = new URLSearchParams({
        sportId: sportCfg.id,
        marketId: marketIds.join(","),
        pageSize: String(pageSize),
        pageNum: String(pageNum),
        todayGames: "false",
        timeline: String(timelineHours),
        _t: String(Date.now()),
      });
      const raw = await this.request<RawUpcomingResponse>(`/factsCenter/pcUpcomingEvents?${params.toString()}`);
      const biz = this.bizError(raw);
      if (biz) throw biz;

      const tournaments = raw?.data?.tournaments ?? [];
      const batch = flattenFixtures(tournaments);
      collected.push(...batch);

      const total = Number(raw?.data?.totalNum ?? 0);
      if (batch.length < pageSize || (total > 0 && collected.length >= total)) {
        break;
      }
    }

    this.cache.set(cacheKey, { at: Date.now(), fixtures: collected });
    return collected;
  }

  async findEvent(
    eventId: string,
    marketIds?: string[],
    sport?: string,
  ): Promise<SportyBetFixture | null> {
    const sportsToSearch = sport
      ? [sport]
      : ["football", "basketball", "tennis", "ice_hockey", "table_tennis", "volleyball", "handball"];

    for (const s of sportsToSearch) {
      const sportCfg = resolveSport(s);
      const fixtures = await this.getFixtures({
        sport: s,
        marketIds: marketIds?.length ? marketIds : sportCfg.defaultMarketIds,
      });
      const match = fixtures.find((f) => f.eventId === eventId);
      if (match) return match;
    }
    return null;
  }

  async createBooking(selections: SportyBetSelection[]): Promise<SportyBetBooking> {
    const payload = {
      selections: selections.map((s) => ({
        eventId: s.eventId,
        marketId: s.marketId,
        specifier: s.specifier ?? null,
        outcomeId: s.outcomeId,
      })),
    };

    const raw = await this.request<RawBookingResponse>("/orders/share", {
      method: "POST",
      body: JSON.stringify(payload),
      retry: false,
    });
    const biz = this.bizError(raw);
    if (biz) throw biz;

    const booking = normalizeBooking(raw?.data ?? {});
    if (!booking.shareCode) {
      throw new SportyBetError(
        "NO_BOOKING_CODE",
        "SportyBet share endpoint did not return a booking code.",
        "Refresh odds and rebuild the betslip.",
      );
    }
    return booking;
  }

  async getBookingStatus(bookingCode: string): Promise<SportyBetBooking> {
    const clean = encodeURIComponent(bookingCode.trim());
    const raw = await this.request<RawBookingResponse>(`/orders/share/${clean}`, {
      method: "GET",
      retry: true,
    });
    const biz = this.bizError(raw);
    if (biz) throw biz;
    return normalizeBooking(raw?.data ?? {});
  }
}
