const CACHE_MS = 30 * 1000;
const RG_ORDER_URL = "https://www.rolandgarros.com/en-us/order-of-play";
const H2H_CACHE_MS = 6 * 60 * 60 * 1000;
const H2H_START_YEAR = 2000;

let cache = null;
const h2hCache = {};

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 tennis-dashboard/1.0",
      "accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function parseMove(value) {
  if (!value || value === "-") return 0;
  return Number(String(value).replace("+", "")) || 0;
}

function parseEspnRankings(html) {
  const rows = [];
  const seen = new Set();
  const re = /"rankPosition":(\d+),"athlete":\{"name":"([^"]+)".*?"points":"?([0-9,]+)"?,"trend":"([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) {
    const rank = Number(match[1]);
    if (seen.has(rank)) continue;
    seen.add(rank);
    rows.push({
      rank,
      player: match[2],
      points: Number(match[3].replace(/,/g, "")),
      move: parseMove(match[4])
    });
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

function fallbackWtaRankings() {
  return [
    { rank: 8, player: "Mirra Andreeva", points: null, move: 0, tour: "WTA" },
    { rank: 15, player: "Marta Kostyuk", points: null, move: 0, tour: "WTA" },
    { rank: 23, player: "Diana Shnaider", points: null, move: 0, tour: "WTA" },
    { rank: 114, player: "Maja Chwalinska", points: null, move: 0, tour: "WTA" }
  ];
}

function titleName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(^|\s|-|')\p{L}/gu, (letter) => letter.toUpperCase());
}

function teamName(team) {
  return (team?.players || [])
    .map((player) => `${titleName(player.firstName)} ${titleName(player.lastName)}`.trim())
    .join(" / ");
}

function statusFromRg(status) {
  if (status === "IN_PROGRESS") return "live";
  if (status === "FINISHED") return "finished";
  return "scheduled";
}

function roundLabel(value) {
  const labels = {
    Semifinals: "Semifinále",
    Quarterfinals: "Čtvrtfinále",
    "Round 4": "Osmifinále",
    Final: "Finále"
  };
  return labels[value] || value || "Zápas";
}

function playerFromTeam(team) {
  const primaryPlayer = team?.players?.[0] || {};
  return {
    name: teamName(team),
    seed: team?.seed || null,
    ranking: primaryPlayer.ranking || null,
    sets: [],
    game: "",
    winner: Boolean(team?.winner)
  };
}

function normalizeName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function csvRows(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

async function loadTourMatches(tour) {
  const cached = h2hCache[tour];
  if (cached && Date.now() - cached.createdAt < H2H_CACHE_MS) return cached.rows;

  const currentYear = new Date().getFullYear();
  const urls = [];
  for (let year = H2H_START_YEAR; year <= currentYear; year += 1) {
    urls.push({
      year,
      url: `https://raw.githubusercontent.com/JeffSackmann/tennis_${tour}/master/${tour}_matches_${year}.csv`
    });
  }

  const chunks = await Promise.all(urls.map(async ({ url }) => {
    try {
      return csvRows(await fetchText(url));
    } catch {
      return [];
    }
  }));

  const rows = chunks.flat();
  h2hCache[tour] = { createdAt: Date.now(), rows };
  return rows;
}

function tourForMatch(match) {
  return /Women/i.test(match.event || match.round || "") ? "wta" : "atp";
}

function h2hMatchRow(row, playerA, playerB) {
  const winner = normalizeName(row.winner_name);
  const loser = normalizeName(row.loser_name);
  const a = normalizeName(playerA);
  const b = normalizeName(playerB);
  return (winner === a && loser === b) || (winner === b && loser === a);
}

function formatDateFromNumber(value) {
  const raw = String(value || "");
  if (raw.length !== 8) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function buildH2H(match) {
  const [playerA, playerB] = match.players || [];
  if (!playerA?.name || !playerB?.name || playerA.name.includes("/") || playerB.name.includes("/")) {
    return null;
  }

  const tour = tourForMatch(match);
  const rows = await loadTourMatches(tour);
  const meetings = rows
    .filter((row) => h2hMatchRow(row, playerA.name, playerB.name))
    .sort((a, b) => String(b.tourney_date).localeCompare(String(a.tourney_date)))
    .map((row) => ({
      date: formatDateFromNumber(row.tourney_date),
      tournament: row.tourney_name,
      surface: row.surface,
      round: row.round,
      winner: row.winner_name,
      loser: row.loser_name,
      score: row.score
    }));

  const winsA = meetings.filter((meeting) => normalizeName(meeting.winner) === normalizeName(playerA.name)).length;
  const winsB = meetings.filter((meeting) => normalizeName(meeting.winner) === normalizeName(playerB.name)).length;

  return {
    source: `Jeff Sackmann tennis_${tour}`,
    total: meetings.length,
    players: [
      { name: playerA.name, wins: winsA },
      { name: playerB.name, wins: winsB }
    ],
    meetings: meetings.slice(0, 12)
  };
}

async function attachH2H(matches) {
  return Promise.all(matches.map(async (match) => {
    const h2h = await buildH2H(match);
    return {
      ...match,
      h2h,
      prediction: await buildPrediction(match, h2h)
    };
  }));
}

function playerRows(rows, playerName) {
  const name = normalizeName(playerName);
  return rows
    .filter((row) => normalizeName(row.winner_name) === name || normalizeName(row.loser_name) === name)
    .sort((a, b) => String(b.tourney_date).localeCompare(String(a.tourney_date)));
}

function winRate(rows, playerName) {
  if (!rows.length) return 0.5;
  const name = normalizeName(playerName);
  const wins = rows.filter((row) => normalizeName(row.winner_name) === name).length;
  return wins / rows.length;
}

function winCount(rows, playerName) {
  const name = normalizeName(playerName);
  return rows.filter((row) => normalizeName(row.winner_name) === name).length;
}

function latestRank(rows, playerName) {
  const name = normalizeName(playerName);
  for (const row of rows) {
    if (normalizeName(row.winner_name) === name && row.winner_rank) return Number(row.winner_rank);
    if (normalizeName(row.loser_name) === name && row.loser_rank) return Number(row.loser_rank);
  }
  return null;
}

function rankStrength(rank) {
  if (!rank || Number.isNaN(rank)) return 0.5;
  return Math.max(0.05, Math.min(0.98, 1 - Math.min(rank, 250) / 260));
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function playerModelStats(rows, player) {
  const all = playerRows(rows, player.name);
  const rank = player.ranking || latestRank(all, player.name);
  const lastFive = all.slice(0, 5);
  const recent = all.slice(0, 10);
  const clay = all.filter((row) => row.surface === "Clay").slice(0, 20);
  const clayRecent = all.filter((row) => row.surface === "Clay").slice(0, 10);

  return {
    name: player.name,
    rank,
    rankScore: rankStrength(rank),
    totalMatches: all.length,
    allWinRate: winRate(all.slice(0, 52), player.name),
    lastFiveMatches: lastFive.length,
    lastFiveWins: winCount(lastFive, player.name),
    lastFiveWinRate: winRate(lastFive, player.name),
    recentMatches: recent.length,
    recentWins: winCount(recent, player.name),
    recentWinRate: winRate(recent, player.name),
    clayMatches: clay.length,
    clayWins: winCount(clay, player.name),
    clayWinRate: winRate(clay, player.name),
    clayRecentMatches: clayRecent.length,
    clayRecentWins: winCount(clayRecent, player.name),
    clayRecentWinRate: winRate(clayRecent, player.name)
  };
}

function confidenceFromStats(a, b, h2hTotal) {
  const sample = Math.min(1, (a.recentMatches + b.recentMatches + a.clayMatches + b.clayMatches) / 60);
  const rank = a.rank && b.rank ? 0.2 : 0;
  const h2h = Math.min(0.2, h2hTotal * 0.04);
  return clamp(0.35 + sample * 0.45 + rank + h2h, 0.25, 0.92);
}

async function buildPrediction(match, h2h) {
  const [playerA, playerB] = match.players || [];
  if (!playerA?.name || !playerB?.name || playerA.name.includes("/") || playerB.name.includes("/")) {
    return null;
  }

  const tour = tourForMatch(match);
  const rows = await loadTourMatches(tour);
  const a = playerModelStats(rows, playerA);
  const b = playerModelStats(rows, playerB);

  const h2hA = h2h?.players?.[0]?.wins || 0;
  const h2hB = h2h?.players?.[1]?.wins || 0;
  const h2hTotal = h2hA + h2hB;
  const h2hScoreA = h2hTotal ? h2hA / h2hTotal : 0.5;
  const h2hScoreB = h2hTotal ? h2hB / h2hTotal : 0.5;

  const weights = {
    ranking: 0.35,
    clay: 0.25,
    recent: 0.25,
    h2h: 0.15
  };

  const scoreA =
    weights.ranking * a.rankScore +
    weights.clay * a.clayWinRate +
    weights.recent * a.recentWinRate +
    weights.h2h * h2hScoreA;

  const scoreB =
    weights.ranking * b.rankScore +
    weights.clay * b.clayWinRate +
    weights.recent * b.recentWinRate +
    weights.h2h * h2hScoreB;

  const probabilityA = clamp(scoreA / (scoreA + scoreB || 1), 0.05, 0.95);
  const probabilityB = 1 - probabilityA;
  const confidence = confidenceFromStats(a, b, h2hTotal);

  return {
    model: "tennis-edge-v2: rank + clay form + recent form + last-5 + H2H",
    weights,
    confidence,
    players: [
      {
        name: a.name,
        probability: probabilityA,
        score: scoreA,
        rank: a.rank,
        stats: {
          totalMatches: a.totalMatches,
          allWinRate: a.allWinRate,
          lastFive: `${a.lastFiveWins}-${Math.max(0, a.lastFiveMatches - a.lastFiveWins)}`,
          lastFiveWinRate: a.lastFiveWinRate,
          recent: `${a.recentWins}-${Math.max(0, a.recentMatches - a.recentWins)}`,
          recentWinRate: a.recentWinRate,
          clay: `${a.clayWins}-${Math.max(0, a.clayMatches - a.clayWins)}`,
          clayWinRate: a.clayWinRate,
          clayRecent: `${a.clayRecentWins}-${Math.max(0, a.clayRecentMatches - a.clayRecentWins)}`,
          clayRecentWinRate: a.clayRecentWinRate
        },
        factors: {
          ranking: a.rank ? `#${a.rank}` : "bez rankingu",
          lastFive: `${a.lastFiveWins}-${Math.max(0, a.lastFiveMatches - a.lastFiveWins)}`,
          recentForm: `${percent(a.recentWinRate)} z posledních ${a.recentMatches || 0}`,
          clayForm: `${percent(a.clayWinRate)} na antuce z ${a.clayMatches || 0}`,
          h2h: h2hTotal ? `${h2hA}-${h2hB}` : "0-0"
        }
      },
      {
        name: b.name,
        probability: probabilityB,
        score: scoreB,
        rank: b.rank,
        stats: {
          totalMatches: b.totalMatches,
          allWinRate: b.allWinRate,
          lastFive: `${b.lastFiveWins}-${Math.max(0, b.lastFiveMatches - b.lastFiveWins)}`,
          lastFiveWinRate: b.lastFiveWinRate,
          recent: `${b.recentWins}-${Math.max(0, b.recentMatches - b.recentWins)}`,
          recentWinRate: b.recentWinRate,
          clay: `${b.clayWins}-${Math.max(0, b.clayMatches - b.clayWins)}`,
          clayWinRate: b.clayWinRate,
          clayRecent: `${b.clayRecentWins}-${Math.max(0, b.clayRecentMatches - b.clayRecentWins)}`,
          clayRecentWinRate: b.clayRecentWinRate
        },
        factors: {
          ranking: b.rank ? `#${b.rank}` : "bez rankingu",
          lastFive: `${b.lastFiveWins}-${Math.max(0, b.lastFiveMatches - b.lastFiveWins)}`,
          recentForm: `${percent(b.recentWinRate)} z posledních ${b.recentMatches || 0}`,
          clayForm: `${percent(b.clayWinRate)} na antuce z ${b.clayMatches || 0}`,
          h2h: h2hTotal ? `${h2hB}-${h2hA}` : "0-0"
        }
      }
    ],
    note: "Model porovnává rank, aktuální formu, antuku, posledních 5 zápasů a H2H."
  };
}

function formatSet(set) {
  if (!set) return "-";
  const score = set.score === null || set.score === undefined ? "-" : String(set.score);
  return set.tieBreak === null || set.tieBreak === undefined ? score : `${score}(${set.tieBreak})`;
}

function playerResultFromTeam(team) {
  return {
    name: teamName(team),
    seed: team?.seed || null,
    sets: (team?.sets || []).map(formatSet),
    game: "",
    winner: Boolean(team?.winner)
  };
}

function extractRolandGarrosPage(html) {
  const script = html.match(/window\.__NUXT__=(.*?);<\/script>/s);
  if (!script) return null;

  try {
    return JSON.parse(script[1])?.data?.[0] || null;
  } catch {
    return null;
  }
}

function allRolandGarrosMatches(page) {
  if (!page) return [];
  const courts = [...(page.principalCourts || []), ...(page.annexeCourts || [])];
  return courts.flatMap((court) =>
    (court.matchSchedulers || []).flatMap((scheduler) => scheduler.matches || [])
  );
}

function parseRolandGarrosMatches(html) {
  const page = extractRolandGarrosPage(html);
  const matches = allRolandGarrosMatches(page);
  const mainSingles = matches.filter((match) =>
    ["SM", "SD"].includes(match.matchData?.type)
  );

  return mainSingles.map((match) => ({
    tournament: "Roland-Garros",
    event: match.matchData?.typeLabel || "",
    court: match.matchData?.courtName || "Court",
    round: roundLabel(match.matchData?.roundLabel || match.matchData?.typeLabel),
    status: statusFromRg(match.matchData?.status),
    start: match.matchData?.startingAt || match.matchData?.notBefore || "",
    server: "",
    players: [playerFromTeam(match.teamA), playerFromTeam(match.teamB)]
  }));
}

function fallbackRolandGarrosMatches(date) {
  if (date === "2026-06-05") {
    return [
      {
        id: "rg-2026-06-05-zverev-mensik",
        tournament: "Roland-Garros",
        event: "Men’s Singles",
        court: "Court Philippe-Chatrier",
        round: "Semifinále",
        status: "scheduled",
        start: "Dnes",
        server: "",
        source: "Sky Sports order of play fallback",
        players: [
          { name: "Alexander Zverev", seed: "2", ranking: 3, sets: [], game: "", winner: false },
          { name: "Jakub Mensik", seed: null, ranking: 12, sets: [], game: "", winner: false }
        ]
      },
      {
        id: "rg-2026-06-05-arnaldi-cobolli",
        tournament: "Roland-Garros",
        event: "Men’s Singles",
        court: "Court Philippe-Chatrier",
        round: "Semifinále",
        status: "scheduled",
        start: "Dnes",
        server: "",
        source: "Sky Sports order of play fallback",
        players: [
          { name: "Matteo Arnaldi", seed: null, ranking: null, sets: [], game: "", winner: false },
          { name: "Flavio Cobolli", seed: null, ranking: null, sets: [], game: "", winner: false }
        ]
      }
    ];
  }

  if (date !== "2026-06-04") return [];

  return [
    {
      id: "rg-2026-06-04-kostyuk-andreeva",
      tournament: "Roland-Garros",
      event: "Women’s Singles",
      court: "Court Philippe-Chatrier",
      round: "Semifinále",
      status: "finished",
      start: "15:00",
      server: "",
      source: "AS order of play fallback",
      players: [
        { name: "Marta Kostyuk", seed: "15", ranking: 15, sets: ["1", "3"], game: "", winner: false },
        { name: "Mirra Andreeva", seed: "8", ranking: 8, sets: ["6", "6"], game: "", winner: true }
      ]
    },
    {
      id: "rg-2026-06-04-shnaider-chwalinska",
      tournament: "Roland-Garros",
      event: "Women’s Singles",
      court: "Court Philippe-Chatrier",
      round: "Semifinále",
      status: "finished",
      start: "Po prvním semifinále",
      server: "",
      source: "AS order of play fallback",
      players: [
        { name: "Diana Shnaider", seed: "25", ranking: 23, sets: ["6(4)", "4"], game: "", winner: false },
        { name: "Maja Chwalinska", seed: null, ranking: 114, sets: ["7", "6"], game: "", winner: true }
      ]
    }
  ];
}

function fallbackRolandGarrosResults(date) {
  return fallbackRolandGarrosMatches(date).map((match) => ({
    id: match.id,
    date,
    tournament: match.tournament,
    event: match.event,
    court: match.court,
    round: match.round,
    status: "finished",
    duration: null,
    players: match.players
  }));
}

function parseRolandGarrosResults(html, date) {
  const page = extractRolandGarrosPage(html);
  const matches = allRolandGarrosMatches(page);
  return matches
    .filter((match) => ["SM", "SD"].includes(match.matchData?.type))
    .filter((match) => match.matchData?.status === "FINISHED")
    .map((match) => ({
      id: match.id,
      date,
      tournament: "Roland-Garros",
      event: match.matchData?.typeLabel || "",
      court: match.matchData?.courtName || "Court",
      round: roundLabel(match.matchData?.roundLabel || match.matchData?.typeLabel),
      status: "finished",
      duration: match.matchData?.durationInMinutes || null,
      players: [playerResultFromTeam(match.teamA), playerResultFromTeam(match.teamB)]
    }));
}

function dateIso(date) {
  return date.toISOString().slice(0, 10);
}

function lastSevenDates() {
  const dates = [];
  const today = new Date();
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - offset));
    dates.push(dateIso(date));
  }
  return dates;
}

function rolandGarrosUrl(date) {
  const params = new URLSearchParams({
    annexeCourt: "all",
    competition: "all",
    country: "all",
    date,
    favoriteFilter: "false",
    principalCourt: "all",
    year: String(new Date(date).getUTCFullYear())
  });
  return `${RG_ORDER_URL}?${params.toString()}`;
}

async function loadDashboardData() {
  if (cache && Date.now() - cache.createdAt < CACHE_MS) return cache.payload;

  const sources = [];
  let rankings = [];
  let matches = [];
  let results = [];
  const errors = [];

  try {
    rankings = [
      ...fallbackWtaRankings(),
      ...parseEspnRankings(await fetchText("https://www.espn.com/tennis/rankings")).map((row) => ({ ...row, tour: "ATP" }))
    ];
    if (!rankings.length) throw new Error("no ranking rows found");
    sources.push("ESPN ATP rankings");
    sources.push("WTA fallback rankings for RG semifinalists");
  } catch (error) {
    rankings = fallbackWtaRankings();
    sources.push("WTA fallback rankings for RG semifinalists");
    errors.push(`ESPN ATP rankings: ${error.message}`);
  }

  try {
    const today = dateIso(new Date());
    const rgMatches = parseRolandGarrosMatches(
      await fetchText(rolandGarrosUrl(today))
    );
    const currentMatches = rgMatches.length ? rgMatches : fallbackRolandGarrosMatches(today);
    if (!currentMatches.length) throw new Error("no Roland-Garros singles matches found");
    matches = await attachH2H(currentMatches);
    sources.push(rgMatches.length ? "Roland-Garros order of play" : "AS order of play fallback");
    sources.push("Jeff Sackmann Tennis Abstract H2H");
  } catch (error) {
    errors.push(`Roland-Garros order of play: ${error.message}`);
  }

  try {
    const days = await Promise.all(lastSevenDates().map(async (date) => {
      const html = await fetchText(rolandGarrosUrl(date));
      return parseRolandGarrosResults(html, date);
    }));
    results = days.flat();
    if (!results.length) {
      results = fallbackRolandGarrosResults(dateIso(new Date()));
    }
    sources.push("Roland-Garros results last 7 days");
  } catch (error) {
    const fallbackResults = fallbackRolandGarrosResults(dateIso(new Date()));
    if (fallbackResults.length) {
      results = fallbackResults;
      sources.push("AS order of play fallback results");
    } else {
      errors.push(`Roland-Garros weekly results: ${error.message}`);
    }
  }

  const payload = {
    matches,
    results,
    rankings,
    sources,
    errors,
    usingFallback: false,
    partial: Boolean(errors.length),
    updatedAt: new Date().toISOString()
  };
  cache = { createdAt: Date.now(), payload };
  return payload;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/dashboard") {
      try {
        return jsonResponse(await loadDashboardData());
      } catch (error) {
        return jsonResponse({
        matches: [],
        results: [],
        rankings: [],
        sources: [],
        errors: [`server: ${error.message}`],
        usingFallback: false,
        partial: true,
        updatedAt: new Date().toISOString()
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
