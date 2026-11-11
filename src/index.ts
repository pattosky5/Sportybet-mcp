#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SportyBetClient, SportyBetError } from "./client.js";
import { logger } from "./logger.js";
import {
  fail,
  sportybetBookBet,
  sportybetCalculateCombinedOdds,
  sportybetGetBookingStatus,
  sportybetGetFixtures,
  sportybetGetMarkets,
  sportybetGetOdds,
  sportybetSearchFixtures,
} from "./tools.js";

const cfg = loadConfig();
const client = new SportyBetClient(cfg);

const server = new McpServer({
  name: "sportybet-mcp",
  version: "1.1.0",
});

const sportSchema = z
  .string()
  .optional()
  .describe(
    'Sport to query: "football", "basketball", "tennis", "ice_hockey", "handball", "table_tennis", "volleyball", "all" (fetches Football, Basketball & Tennis together), or a raw Betradar ID like "sr:sport:2".',
  );

function wrapError(toolName: string, err: unknown) {
  if (err instanceof SportyBetError) {
    logger.warn({ tool: toolName, code: err.code, message: err.message });
    return fail(err.code, err.message, err.action);
  }
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ tool: toolName, message: msg });
  return fail("INTERNAL_ERROR", msg, "Check server logs and try again.");
}

server.tool(
  "sportybet_get_fixtures",
  "Fetch upcoming SportyBet fixtures across any sport (Football, Basketball, Tennis, Ice Hockey, Handball, Table Tennis, Volleyball, or all).",
  {
    sport: sportSchema,
    date: z.string().optional().describe("Filter by date in YYYY-MM-DD format (WAT / UTC+1)."),
    league: z.string().optional().describe("Filter by league, tournament, or country name."),
    limit: z.number().int().min(1).max(500).optional().describe("Max fixtures to return (default 50)."),
  },
  async (args) => {
    try {
      return await sportybetGetFixtures(client, args, cfg.tzOffsetMinutes);
    } catch (err) {
      return wrapError("sportybet_get_fixtures", err);
    }
  },
);

server.tool(
  "sportybet_get_markets",
  "Get all available betting markets, specifiers, outcomes, and live odds for a specific SportyBet event ID.",
  {
    eventId: z.string().min(1).describe('SportyBet event ID (e.g., "sr:match:67015328").'),
    sport: sportSchema,
  },
  async (args) => {
    try {
      return await sportybetGetMarkets(client, args);
    } catch (err) {
      return wrapError("sportybet_get_markets", err);
    }
  },
);

server.tool(
  "sportybet_get_odds",
  "Fetch timestamped odds lines across one or more SportyBet event IDs.",
  {
    eventIds: z.array(z.string().min(1)).min(1).max(50).describe("List of SportyBet event IDs."),
    sport: sportSchema,
  },
  async (args) => {
    try {
      return await sportybetGetOdds(client, args);
    } catch (err) {
      return wrapError("sportybet_get_odds", err);
    }
  },
);

server.tool(
  "sportybet_search_fixtures",
  "Search upcoming SportyBet events by team name, player name, league, or country across all sports.",
  {
    query: z.string().min(1).describe("Team, player, league, or country name to search."),
    sport: sportSchema,
    date: z.string().optional().describe("Optional YYYY-MM-DD filter (WAT / UTC+1)."),
    limit: z.number().int().min(1).max(500).optional().describe("Max matches to return (default 50)."),
  },
  async (args) => {
    try {
      return await sportybetSearchFixtures(client, args, cfg.tzOffsetMinutes);
    } catch (err) {
      return wrapError("sportybet_search_fixtures", err);
    }
  },
);

server.tool(
  "sportybet_calculate_combined_odds",
  "Multiply decimal odds across selections to calculate combined accumulator odds (pure math, no prediction).",
  {
    selections: z
      .array(
        z.object({
          odds: z.number().positive().describe("Decimal odds for this leg."),
        }),
      )
      .min(1)
      .max(50),
  },
  async (args) => {
    try {
      return sportybetCalculateCombinedOdds(args);
    } catch (err) {
      return wrapError("sportybet_calculate_combined_odds", err);
    }
  },
);

server.tool(
  "sportybet_book_bet",
  "Validate live selections across any sport and generate a real, non-staking SportyBet booking code.",
  {
    selections: z
      .array(
        z.object({
          eventId: z.string().min(1),
          marketId: z.string().min(1),
          outcomeId: z.string().min(1),
          specifier: z.string().nullable().optional(),
          odds: z.number().positive().optional(),
        }),
      )
      .min(1)
      .max(40),
  },
  async (args) => {
    try {
      return await sportybetBookBet(client, args);
    } catch (err) {
      return wrapError("sportybet_book_bet", err);
    }
  },
);

server.tool(
  "sportybet_get_booking_status",
  "Read legs, live odds, and expiry details for an existing SportyBet booking code (read-only).",
  {
    bookingCode: z.string().min(1).describe("SportyBet booking / share code."),
  },
  async (args) => {
    try {
      return await sportybetGetBookingStatus(client, args);
    } catch (err) {
      return wrapError("sportybet_get_booking_status", err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ message: "SportyBet multi-sport MCP server running on stdio" });
}

main().catch((err) => {
  logger.error({ message: "Fatal startup error", error: String(err) });
  process.exit(1);
});
