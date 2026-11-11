import type { SportyBetClient } from "./client.js";
import type { SportyBetFixture, SportyBetSelection } from "./types.js";
import { calcCombinedOdds, OddsError } from "./odds.js";
import { validateSelections } from "./validation.js";
import { logger } from "./logger.js";
import { resolveSport } from "./marketCatalogue.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const HOUR_MS = 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 500;

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(code: string, message: string, action?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message, action } }, null, 2) }],
    isError: true,
  };
}

function clampLimit(limit: number | undefined, fallback = 50): number {
  const n = Math.floor(limit ?? fallback);
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function dayBounds(date: string, tzOffsetMinutes: number): { start: number; end: number } | null {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const utcStart = Date.UTC(y!, m! - 1, d!);
  return {
    start: utcStart - tzOffsetMinutes * 60_000,
    end: utcStart - tzOffsetMinutes * 60_000 + 24 * HOUR_MS,
  };
}

function timelineForDate(date: string | undefined, tzOffsetMinutes: number, now = Date.now()): number {
  if (!date) return 168;
  const bounds = dayBounds(date, tzOffsetMinutes);
  if (!bounds) return 168;
  const hours = Math.ceil((bounds.end - now) / HOUR_MS);
  return Math.min(Math.max(hours, 12), 720);
}

function fixtureProjection(f: SportyBetFixture) {
  return {
    eventId: f.eventId,
    league: f.league,
    leagueId: f.leagueId,
    category: f.category,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    startTime: f.startTime,
    matchStatus: f.matchStatus,
    marketCount: f.markets.length,
  };
}

export async function sportybetGetFixtures(
  client: SportyBetClient,
  args: { sport?: string; date?: string; league?: string; limit?: number },
  cfgTzOffsetMinutes: number,
): Promise<ToolResult> {
  const limit = clampLimit(args.limit);
  const timeline = timelineForDate(args.date, cfgTzOffsetMinutes);
  const fixtures = await client.getFixtures({
    sport: args.sport,
    timelineHours: timeline,
    maxPages: Math.ceil(limit / 100) + 1,
  });

  let filtered = fixtures;
  const bounds = args.date ? dayBounds(args.date, cfgTzOffsetMinutes) : null;
  if (bounds) {
    filtered = filtered.filter((f) => f.startTimeMs >= bounds!.start && f.startTimeMs < bounds!.end);
  }
  if (args.league) {
    const q = args.league.toLowerCase();
    filtered = filtered.filter(
      (f) => f.league.toLowerCase().includes(q) || f.category.toLowerCase().includes(q),
    );
  }

  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    sport: args.sport ?? "football",
    date: args.date ?? null,
    league: args.league ?? null,
    count: Math.min(filtered.length, limit),
    fixtures: filtered.slice(0, limit).map(fixtureProjection),
  };
  logger.info({ tool: "sportybet_get_fixtures", success: true, sport: result.sport, count: result.count });
  return ok(result);
}

export async function sportybetGetMarkets(
  client: SportyBetClient,
  args: { eventId: string; sport?: string },
): Promise<ToolResult> {
  const marketIds = args.sport ? resolveSport(args.sport).defaultMarketIds : undefined;
  const fixture = await client.findEvent(args.eventId, marketIds, args.sport);
  if (!fixture) {
    return fail(
      "EVENT_NOT_FOUND",
      `Event ${args.eventId} was not found in SportyBet's upcoming list.`,
      "Refresh the fixtures or specify the sport parameter; the event may have started or been removed.",
    );
  }
  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    eventId: fixture.eventId,
    event: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
    league: fixture.league,
    startTime: fixture.startTime,
    markets: fixture.markets.map((m) => ({
      marketId: m.marketId,
      marketName: m.marketName,
      specifier: m.specifier,
      status: m.status,
      lastOddsChangeTime: m.lastOddsChangeTime ?? null,
      outcomes: m.outcomes.map((o) => ({
        outcomeId: o.outcomeId,
        outcomeName: o.outcomeName,
        odds: o.odds,
        isActive: o.isActive,
      })),
    })),
  };
  logger.info({ tool: "sportybet_get_markets", success: true, eventId: args.eventId, markets: result.markets.length });
  return ok(result);
}

export async function sportybetGetOdds(
  client: SportyBetClient,
  args: { eventIds: string[]; sport?: string },
): Promise<ToolResult> {
  const ids = [...new Set(args.eventIds.slice(0, 50))];
  if (!ids.length) return fail("NO_EVENT_IDS", "Provide at least one eventId.", "Call sportybet_get_fixtures first.");
  const fixtures = await client.getFixtures({ sport: args.sport ?? "all" });
  const byId = new Map(fixtures.map((f) => [f.eventId, f]));
  const found = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const missing = ids.filter((id) => !byId.has(id));

  const timestamp = new Date().toISOString();
  const oddsLines = found.flatMap((f) =>
    f.markets.flatMap((m) =>
      m.outcomes
        .filter((o) => Number.isFinite(o.odds) && o.odds > 0)
        .map((o) => ({
          eventId: f.eventId,
          event: `${f.homeTeam} vs ${f.awayTeam}`,
          league: f.league,
          startTime: f.startTime,
          marketId: m.marketId,
          market: m.marketName,
          specifier: m.specifier,
          outcomeId: o.outcomeId,
          outcome: o.outcomeName,
          odds: o.odds,
        })),
    ),
  );

  const result = {
    success: true,
    fetchedAt: timestamp,
    oddsTimestamp: timestamp,
    count: oddsLines.length,
    odds: oddsLines,
    missingEvents: missing,
    note: "Odds change frequently. Treat every value as a snapshot taken at oddsTimestamp.",
  };
  logger.info({ tool: "sportybet_get_odds", success: true, events: found.length, lines: oddsLines.length });
  return ok(result);
}

export async function sportybetSearchFixtures(
  client: SportyBetClient,
  args: { query: string; sport?: string; date?: string; limit?: number },
  cfgTzOffsetMinutes: number,
): Promise<ToolResult> {
  const limit = clampLimit(args.limit);
  const query = args.query.trim().toLowerCase();
  if (!query) return fail("EMPTY_QUERY", "Provide a search query.", "Search by team name, player name, league, or country.");
  const timeline = timelineForDate(args.date, cfgTzOffsetMinutes);
  const fixtures = await client.getFixtures({ sport: args.sport ?? "all", timelineHours: timeline });

  const bounds = args.date ? dayBounds(args.date, cfgTzOffsetMinutes) : null;
  const matches = fixtures
    .filter((f) => {
      if (bounds && (f.startTimeMs < bounds!.start || f.startTimeMs >= bounds!.end)) return false;
      const haystack = `${f.homeTeam} ${f.awayTeam} ${f.league} ${f.category}`.toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, limit);

  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    query: args.query,
    sport: args.sport ?? "all",
    date: args.date ?? null,
    count: matches.length,
    fixtures: matches.map(fixtureProjection),
  };
  logger.info({ tool: "sportybet_search_fixtures", success: true, query: args.query, count: matches.length });
  return ok(result);
}

export function sportybetCalculateCombinedOdds(args: { selections: { odds: number }[] }): ToolResult {
  const odds = args.selections.map((s) => s.odds);
  try {
    const combined = calcCombinedOdds(odds);
    const result = {
      success: true,
      combinedOdds: combined,
      selectionCount: odds.length,
      note: "Combined odds are decimal odds multiplied together. This is not a probability estimate and does not guarantee any payout.",
    };
    logger.info({ tool: "sportybet_calculate_combined_odds", success: true, count: odds.length });
    return ok(result);
  } catch (err) {
    if (err instanceof OddsError) return fail("INVALID_ODDS", err.message, "Provide finite positive decimal odds for every selection.");
    throw err;
  }
}

export async function sportybetBookBet(
  client: SportyBetClient,
  args: { selections: SportyBetSelection[] },
): Promise<ToolResult> {
  if (!args.selections.length) {
    return fail("EMPTY_SELECTIONS", "Provide at least one selection to book.", "Fetch fixtures and markets first.");
  }

  const liveFixtures = await client.getFixtures({ sport: "all" });
  const validation = validateSelections(args.selections, liveFixtures);
  if (!validation.valid) {
    return fail(
      "VALIDATION_FAILED",
      `Selection validation failed: ${validation.errors.join("; ")}`,
      "Refresh odds and rebuild selections before booking.",
    );
  }

  const booking = await client.createBooking(args.selections);
  const legOdds = booking.legs
    .map((l) => Number((l as unknown as Record<string, unknown>).odds ?? (l as unknown as Record<string, unknown>).currentOdds ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const combinedOdds = legOdds.length ? calcCombinedOdds(legOdds) : null;

  const result = {
    success: true,
    bookingCode: booking.shareCode,
    shareURL: booking.shareURL,
    expiresAt: booking.deadlineMs ? new Date(booking.deadlineMs).toISOString() : null,
    combinedOdds,
    legs: booking.legs,
    unavailableOutcomes: booking.unavailableOutcomes,
    note: "Non-staking booking code created. Paste this code into SportyBet Nigeria to review and stake manually.",
  };
  logger.info({ tool: "sportybet_book_bet", success: true, bookingCode: booking.shareCode });
  return ok(result);
}

export async function sportybetGetBookingStatus(
  client: SportyBetClient,
  args: { bookingCode: string },
): Promise<ToolResult> {
  const code = args.bookingCode.trim();
  if (!code) {
    return fail("INVALID_BOOKING_CODE", "Provide a non-empty booking code.", "Check the booking code and retry.");
  }
  const booking = await client.getBookingStatus(code);
  const result = {
    success: true,
    bookingCode: booking.shareCode,
    shareURL: booking.shareURL,
    expiresAt: booking.deadlineMs ? new Date(booking.deadlineMs).toISOString() : null,
    legs: booking.legs,
    unavailableOutcomes: booking.unavailableOutcomes,
  };
  logger.info({ tool: "sportybet_get_booking_status", success: true, bookingCode: code });
  return ok(result);
}
