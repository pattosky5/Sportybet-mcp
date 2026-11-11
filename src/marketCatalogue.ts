export interface SportConfig {
  id: string;
  name: string;
  aliases: string[];
  defaultMarketIds: string[];
}

export const SPORT_CATALOGUE: Record<string, SportConfig> = {
  football: {
    id: "sr:sport:1",
    name: "Football",
    aliases: ["football", "soccer", "sr:sport:1"],
    defaultMarketIds: ["1", "18", "10", "29", "11", "26", "36", "14", "60100"],
  },
  basketball: {
    id: "sr:sport:2",
    name: "Basketball",
    aliases: ["basketball", "nba", "euroleague", "ncaa", "sr:sport:2"],
    defaultMarketIds: ["219", "186", "223", "225", "227", "228", "229", "60"],
  },
  tennis: {
    id: "sr:sport:5",
    name: "Tennis",
    aliases: ["tennis", "atp", "wta", "itf", "challenger", "sr:sport:5"],
    defaultMarketIds: ["186", "187", "188", "189", "190", "191", "202"],
  },
  ice_hockey: {
    id: "sr:sport:4",
    name: "Ice Hockey",
    aliases: ["ice_hockey", "hockey", "nhl", "sr:sport:4"],
    defaultMarketIds: ["1", "18", "10", "11", "14", "29"],
  },
  handball: {
    id: "sr:sport:6",
    name: "Handball",
    aliases: ["handball", "sr:sport:6"],
    defaultMarketIds: ["1", "18", "10", "14"],
  },
  table_tennis: {
    id: "sr:sport:20",
    name: "Table Tennis",
    aliases: ["table_tennis", "ping_pong", "sr:sport:20"],
    defaultMarketIds: ["186", "187", "189", "202"],
  },
  volleyball: {
    id: "sr:sport:23",
    name: "Volleyball",
    aliases: ["volleyball", "sr:sport:23"],
    defaultMarketIds: ["186", "187", "189", "202"],
  },
};

export const ALL_SUPPORTED_SPORTS = Object.keys(SPORT_CATALOGUE);

export function resolveSport(sportInput?: string): SportConfig {
  if (!sportInput) return SPORT_CATALOGUE.football!;
  const normalized = sportInput.trim().toLowerCase().replace(/[\s-]+/g, "_");
  for (const cfg of Object.values(SPORT_CATALOGUE)) {
    if (cfg.aliases.includes(normalized) || cfg.id.toLowerCase() === normalized) {
      return cfg;
    }
  }
  if (normalized.startsWith("sr:sport:")) {
    return {
      id: normalized,
      name: normalized,
      aliases: [normalized],
      defaultMarketIds: ["1", "186", "18", "10", "14"],
    };
  }
  return SPORT_CATALOGUE.football!;
}

export const MARKET_CATALOGUE: ReadonlyArray<readonly [string, string]> = [
  ["1", "1X2"],
  ["60100", "1X2 - 2UP"],
  ["60200", "1X2 - 1UP"],
  ["60210", "1X2 - Never Down"],
  ["60110", "Double Chance - 1UP"],
  ["10", "Double Chance"],
  ["11", "Draw No Bet"],
  ["12", "Home No Bet"],
  ["13", "Away No Bet"],
  ["14", "Handicap"],
  ["15", "Winning Margin"],
  ["16", "Asian Handicap -1.5"],
  ["18", "Over/Under"],
  ["29", "GG/NG"],
  ["35", "1X2 & GG/NG"],
  ["36", "Over/Under & GG/NG"],
  ["37", "1X2 & Over/Under 1.5"],
  ["60", "1st Half - 1X2"],
  ["68", "1st Half - Over/Under"],
  ["83", "2nd Half - 1X2"],
  ["90", "2nd Half - Over/Under"],
  ["186", "Winner (2-Way)"],
  ["187", "Game / Point Handicap"],
  ["188", "1st Set Winner"],
  ["189", "Total Games / Points"],
  ["190", "Player 1 Total Games"],
  ["191", "Player 2 Total Games"],
  ["202", "Set Handicap"],
  ["219", "Winner (Incl. Overtime)"],
  ["223", "Point Spread (Incl. OT)"],
  ["225", "Total Points (Incl. OT)"],
  ["227", "Home Team Total Points"],
  ["228", "Away Team Total Points"],
  ["229", "Odd/Even (Incl. OT)"],
];

export function marketNameForId(id: string): string | undefined {
  const found = MARKET_CATALOGUE.find(([marketId]) => marketId === id);
  return found ? found[1] : undefined;
}

export const DEFAULT_MARKET_IDS = SPORT_CATALOGUE.football!.defaultMarketIds;
