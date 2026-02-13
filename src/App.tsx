import React, { useEffect, useMemo, useRef, useState } from "react";

type ID = string;

type Player = { id: ID; name: string; active: boolean };
type TournamentType = "draft" | "sealed";
type Stage = "roundrobin" | "playoffs" | "done";

type RRMatch = { id: ID; a: ID; b: ID; winsA: number; winsB: number; done: boolean };
type POPhase = "SF1" | "SF2" | "F";
type POMatch = { id: ID; phase: POPhase; a: ID; b: ID; winsA: number; winsB: number; done: boolean };

type Tournament = {
  id: ID;
  name: string;
  dateISO: string;
  type: TournamentType;
  playerIds: ID[];
  stage: Stage;
  rrMatches: RRMatch[];
  poMatches: POMatch[];
  seedOverride?: ID[]; // [seed1, seed2, seed3, seed4]
  winnerId?: ID;
  createdAt: number;
};

type AppState = { players: Player[]; tournaments: Tournament[] };

const LS_KEY = "mtg_draft_tracker_ui_v3";

function extractOrderNumber(name: string): number | null {
  const match = name.trim().match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function uid(prefix = "id"): ID {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function formatDateISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function byName(a: Player, b: Player) {
  return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
}
function getPlayerName(players: Player[], id: ID) {
  return players.find(p => p.id === id)?.name ?? "—";
}
function prettyType(t: TournamentType) {
  return t === "draft" ? "Draft" : "Sealed";
}
function phaseLabel(p: POPhase) {
  if (p === "SF1") return "Semifinale 1 (1 vs 4)";
  if (p === "SF2") return "Semifinale 2 (2 vs 3)";
  return "Finale";
}

function calcRRStandings(players: Player[], t: Tournament) {
  const map = new Map<ID, { id: ID; name: string; pts: number; pf: number; pa: number; diff: number }>();
  for (const pid of t.playerIds) map.set(pid, { id: pid, name: getPlayerName(players, pid), pts: 0, pf: 0, pa: 0, diff: 0 });

  for (const m of t.rrMatches) {
    if (!m.done) continue;
    const A = map.get(m.a);
    const B = map.get(m.b);
    if (!A || !B) continue;

    A.pts += m.winsA;
    B.pts += m.winsB;

    A.pf += m.winsA; A.pa += m.winsB;
    B.pf += m.winsB; B.pa += m.winsA;
  }

  const list = Array.from(map.values()).map(x => ({ ...x, diff: x.pf - x.pa }));
  list.sort((x, y) => {
    if (y.pts !== x.pts) return y.pts - x.pts;
    if (y.diff !== x.diff) return y.diff - x.diff;
    return x.name.localeCompare(y.name, "it", { sensitivity: "base" });
  });
  return list;
}

function buildRRMatches(playerIds: ID[]) {
  const matches: RRMatch[] = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      matches.push({ id: uid("rr"), a: playerIds[i], b: playerIds[j], winsA: 0, winsB: 0, done: false });
    }
  }
  return matches;
}
function canCloseRR(t: Tournament) {
  return t.rrMatches.length > 0 && t.rrMatches.every(m => m.done);
}
function pickTop4(standings: ReturnType<typeof calcRRStandings>) {
  return standings.slice(0, 4).map(s => s.id);
}
function buildPlayoffs(top4: ID[]) {
  if (top4.length < 4) return [];
  const [s1, s2, s3, s4] = top4;
  const sf1: POMatch = { id: uid("po"), phase: "SF1", a: s1, b: s4, winsA: 0, winsB: 0, done: false };
  const sf2: POMatch = { id: uid("po"), phase: "SF2", a: s2, b: s3, winsA: 0, winsB: 0, done: false };
  const fin: POMatch = { id: uid("po"), phase: "F", a: s1, b: s2, winsA: 0, winsB: 0, done: false }; // placeholder
  return [sf1, sf2, fin];
}
function getWinnerId(m: { a: ID; b: ID; winsA: number; winsB: number; done: boolean }): ID | null {
  if (!m.done) return null;
  if (m.winsA > m.winsB) return m.a;
  if (m.winsB > m.winsA) return m.b;
  return null;
}
function getLoserId(m: { a: ID; b: ID; winsA: number; winsB: number; done: boolean }): ID | null {
  const w = getWinnerId(m);
  if (!w) return null;
  return w === m.a ? m.b : m.a;
}
function ensureFinalHasCorrectPlayers(t: Tournament) {
  const sf1 = t.poMatches.find(m => m.phase === "SF1");
  const sf2 = t.poMatches.find(m => m.phase === "SF2");
  const fin = t.poMatches.find(m => m.phase === "F");
  if (!sf1 || !sf2 || !fin) return t;

  const w1 = getWinnerId(sf1);
  const w2 = getWinnerId(sf2);
  if (!w1 || !w2) return t;

  if ((fin.a === w1 && fin.b === w2) || (fin.a === w2 && fin.b === w1)) return t;

  const newFinal: POMatch = { ...fin, a: w1, b: w2, winsA: 0, winsB: 0, done: false };
  return { ...t, poMatches: t.poMatches.map(m => (m.phase === "F" ? newFinal : m)) };
}
function computeTournamentWinner(t: Tournament) {
  const fin = t.poMatches.find(m => m.phase === "F");
  const w = fin ? getWinnerId(fin) : null;
  return w ?? undefined;
}

function trophyForRank(rank: number) {
  if (rank === 1) return "🏆";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return "•";
}

export default function App() {
  const [state, setState] = useState<AppState>(() => {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      const initialPlayers: Player[] = [
        { id: uid("p"), name: "Antonio", active: true },
        { id: uid("p"), name: "Luca", active: true },
        { id: uid("p"), name: "Alessandro", active: true },
        { id: uid("p"), name: "Leonardo", active: true },
        { id: uid("p"), name: "Claudio", active: true },
        { id: uid("p"), name: "Lorenzo", active: true },
      ].sort(byName);
      return { players: initialPlayers, tournaments: [] };
    }
    try {
      return JSON.parse(raw) as AppState;
    } catch {
      return { players: [], tournaments: [] };
    }
  });

  const [selectedTournamentId, setSelectedTournamentId] = useState<ID | null>(null);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }, [state]);

  const playersSorted = useMemo(() => [...state.players].sort(byName), [state.players]);

  const selectedTournament = useMemo(
    () => state.tournaments.find(t => t.id === selectedTournamentId) ?? null,
    [state.tournaments, selectedTournamentId]
  );

  // ---- Export/Import
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mtg-tournaments-backup-${formatDateISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function importJSON(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as AppState;
        if (!parsed || !Array.isArray(parsed.players) || !Array.isArray(parsed.tournaments)) return;
        setState(parsed);
        setSelectedTournamentId(null);
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  }

  // ---- Players
  const [newPlayerName, setNewPlayerName] = useState("");
  function addPlayer(name: string) {
    const clean = name.trim();
    if (!clean) return;
    setState(s => ({ ...s, players: [...s.players, { id: uid("p"), name: clean, active: true }].sort(byName) }));
  }
  function togglePlayerActive(id: ID) {
    setState(s => ({ ...s, players: s.players.map(p => (p.id === id ? { ...p, active: !p.active } : p)) }));
  }
  function renamePlayer(id: ID, name: string) {
    const clean = name.trim();
    if (!clean) return;
    setState(s => ({ ...s, players: s.players.map(p => (p.id === id ? { ...p, name: clean } : p)).sort(byName) }));
  }

  // ---- New tournament
  const [newTName, setNewTName] = useState("");
  const [newTDate, setNewTDate] = useState(formatDateISO());
  const [newTType, setNewTType] = useState<TournamentType>("draft");
  const [newTSelected, setNewTSelected] = useState<Record<ID, boolean>>({});

  useEffect(() => {
    if (Object.keys(newTSelected).length === 0) {
      const init: Record<ID, boolean> = {};
      for (const p of playersSorted) init[p.id] = p.active;
      setNewTSelected(init);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPlayersForNew = useMemo(() => playersSorted.filter(p => newTSelected[p.id]), [playersSorted, newTSelected]);

  function createTournament(opts: { name: string; dateISO: string; type: TournamentType; playerIds: ID[] }) {
    const clean = opts.name.trim();
    if (!clean || opts.playerIds.length < 4) return;

    const t: Tournament = {
      id: uid("t"),
      name: clean,
      dateISO: opts.dateISO,
      type: opts.type,
      playerIds: opts.playerIds,
      stage: "roundrobin",
      rrMatches: buildRRMatches(opts.playerIds),
      poMatches: [],
      createdAt: Date.now(),
    };

	seedOverride: undefined,

    setState(s => ({ ...s, tournaments: [t, ...s.tournaments] }));
    setSelectedTournamentId(t.id);
  }

  function updateTournament(tid: ID, patch: Partial<Tournament>) {
    setState(s => ({ ...s, tournaments: s.tournaments.map(t => (t.id === tid ? { ...t, ...patch } : t)) }));
  }

  // ---- RR results (girone sempre 2 game)
  function setRRResult(matchId: ID, winsA: number, winsB: number) {
    if (!selectedTournament) return;
    const a = clamp(winsA, 0, 2);
    const b = clamp(winsB, 0, 2);
    if (a + b !== 2) return;

    updateTournament(selectedTournament.id, {
      rrMatches: selectedTournament.rrMatches.map(m => (m.id === matchId ? { ...m, winsA: a, winsB: b, done: true } : m)),
    });
  }
  function unsetRR(matchId: ID) {
    if (!selectedTournament) return;
    updateTournament(selectedTournament.id, {
      rrMatches: selectedTournament.rrMatches.map(m => (m.id === matchId ? { ...m, winsA: 0, winsB: 0, done: false } : m)),
    });
  }
  function closeRoundRobinAndStartPlayoffs() {
	if (!selectedTournament) return;
	if (!canCloseRR(selectedTournament)) return;

	const standings = calcRRStandings(state.players, selectedTournament);
	const top4Auto = pickTop4(standings);

	const ov = selectedTournament.seedOverride;
	const useOverride = ov && ov.length === 4 && new Set(ov).size === 4;

	const seeds = useOverride ? ov! : top4Auto;

	if (seeds.length < 4) return; // safety

	const po = buildPlayoffs(seeds);
	updateTournament(selectedTournament.id, { stage: "playoffs", poMatches: po });
  }


  // ---- Playoffs
  function setPOWins(matchId: ID, winsA: number, winsB: number) {
    if (!selectedTournament) return;

    const a = clamp(winsA, 0, 2);
    const b = clamp(winsB, 0, 2);
    if (a === 2 && b === 2) return;
    const done = a === 2 || b === 2;

    let next: Tournament = {
      ...selectedTournament,
      poMatches: selectedTournament.poMatches.map(m => (m.id === matchId ? { ...m, winsA: a, winsB: b, done } : m)),
    };
    next = ensureFinalHasCorrectPlayers(next);
    const winnerId = computeTournamentWinner(next);
    const stage: Stage = winnerId ? "done" : next.stage;

    updateTournament(selectedTournament.id, { poMatches: next.poMatches, winnerId, stage });
  }

  // ---- Derived for selected tournament
  const standings = useMemo(() => (selectedTournament ? calcRRStandings(state.players, selectedTournament) : []), [state.players, selectedTournament]);
  const rrDoneCount = useMemo(() => (selectedTournament ? selectedTournament.rrMatches.filter(m => m.done).length : 0), [selectedTournament]);

  // ---- Quick entry
  const [quickMode, setQuickMode] = useState(true);
  const rrPending = useMemo(() => (selectedTournament ? selectedTournament.rrMatches.filter(m => !m.done) : []), [selectedTournament]);
  const nextPending = rrPending[0] ?? null;
  const quickRef = useRef<HTMLDivElement | null>(null);
  const [showSeedOverride, setShowSeedOverride] = useState(false);

  function quickSet(result: "2-0" | "1-1" | "0-2") {
    if (!selectedTournament || !nextPending) return;
    if (result === "2-0") setRRResult(nextPending.id, 2, 0);
    if (result === "1-1") setRRResult(nextPending.id, 1, 1);
    if (result === "0-2") setRRResult(nextPending.id, 0, 2);
    setTimeout(() => quickRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  // ---- Hall of Fame (always on top)
  const hall = useMemo(() => {
    type Row = { id: ID; name: string; titles: number; finals: number; top4: number };
    const map = new Map<ID, Row>();
    for (const p of state.players) map.set(p.id, { id: p.id, name: p.name, titles: 0, finals: 0, top4: 0 });

    const tournamentsDone: Array<{ id: ID; dateISO: string; name: string; champion?: ID; finalist?: ID }> = [];

    for (const t of state.tournaments) {
      if (t.stage !== "done" || !t.winnerId) continue;

      const sf1 = t.poMatches.find(m => m.phase === "SF1");
      const sf2 = t.poMatches.find(m => m.phase === "SF2");
      const fin = t.poMatches.find(m => m.phase === "F");
      const champion = t.winnerId;
      const finalist = fin ? (getLoserId(fin) ?? undefined) : undefined;

      tournamentsDone.push({ id: t.id, dateISO: t.dateISO, name: t.name, champion, finalist });

      const c = map.get(champion);
      if (c) { c.titles += 1; c.finals += 1; }
      if (finalist) {
        const f = map.get(finalist);
        if (f) f.finals += 1;
      }

      const top4 = new Set<ID>();
      if (sf1) { top4.add(sf1.a); top4.add(sf1.b); }
      if (sf2) { top4.add(sf2.a); top4.add(sf2.b); }
      for (const pid of top4) {
        const r = map.get(pid);
        if (r) r.top4 += 1;
      }
    }

    const rowsRanked = Array.from(map.values()).sort((a, b) => {
      // 1) più titoli
      if (b.titles !== a.titles) return b.titles - a.titles;
      // 2) più finali (apparizioni in finale, incluse le vittorie)
      if (b.finals !== a.finals) return b.finals - a.finals;
      // 3) più top4
      if (b.top4 !== a.top4) return b.top4 - a.top4;
      // 4) nome
      return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
    });

tournamentsDone.sort((a, b) => {
  const na = extractOrderNumber(a.name);
  const nb = extractOrderNumber(b.name);

  if (na !== null && nb !== null) return na - nb;     // ordine numerico
  if (na !== null) return -1;                         // a prima
  if (nb !== null) return 1;                          // b prima
  return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
});

return { rowsRanked, tournamentsDone };

  }, [state.players, state.tournaments]);

  // ---- Active tournaments list (non-finished first)
  const activeTournaments = useMemo(() => {
    const list = [...state.tournaments];
    list.sort((a, b) => {
      // 1) attivi prima dei conclusi
      if (a.stage === "done" && b.stage !== "done") return 1;
      if (a.stage !== "done" && b.stage === "done") return -1;

      // 2) numero nel nome (1°, 2°, 12°...)
      const na = extractOrderNumber(a.name);
      const nb = extractOrderNumber(b.name);

      if (na !== null && nb !== null) return na - nb;
      if (na !== null) return -1;
      if (nb !== null) return 1;

      // 3) fallback alfabetico
      return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
    });

    return list;
  }, [state.tournaments]);

  // ---- Styling (dark MTG)
const S = {
  page: {
    minHeight: "100vh",
    padding: 16,
    // dark soft: non nero pieno, più “carbone”
    background: "linear-gradient(180deg, #12131a 0%, #161824 45%, #12131a 100%)",
    color: "#ECECF6",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  } as React.CSSProperties,

  topbar: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  } as React.CSSProperties,

  title: { margin: 0, fontSize: 24, letterSpacing: 0.2 } as React.CSSProperties,
  subtle: { opacity: 0.78, fontSize: 13 } as React.CSSProperties,

  // card stile “JapaneseApp”: bordo sottile + shadow morbida + rounded grandi
  card: {
    background: "rgba(255,255,255,0.06)",          // più chiaro del nero
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 22,
    padding: 14,
    boxShadow: "0 18px 55px rgba(0,0,0,0.35)",
    backdropFilter: "blur(10px)",
  } as React.CSSProperties,

  panel: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 18,
    background: "rgba(0,0,0,0.14)",
    overflow: "hidden",
  } as React.CSSProperties,

  panelHeader: {
    padding: 12,
    fontWeight: 900,
    background: "rgba(255,255,255,0.05)",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
  } as React.CSSProperties,

  row: {
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.04)",
  } as React.CSSProperties,

  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 11px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.10)",
  } as React.CSSProperties,

  btn: {
    padding: "9px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.04)",
    color: "#ECECF6",
    cursor: "pointer",
  } as React.CSSProperties,

  // accento MTG ma soft (non troppo “neon”)
  btnPrimary: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(135deg, rgba(176, 34, 93, 0.65), rgba(112, 62, 186, 0.55))",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
    boxShadow: "0 10px 28px rgba(176, 34, 93, 0.16)",
  } as React.CSSProperties,

  input: {
    width: "100%",
    padding: 11,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.12)",
    color: "#ECECF6",
    outline: "none",
  } as React.CSSProperties,

  table: { width: "100%", borderCollapse: "collapse" } as React.CSSProperties,
  th: {
    textAlign: "left",
    padding: 10,
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    fontSize: 12,
    opacity: 0.82,
    letterSpacing: 0.2,
  } as React.CSSProperties,
  td: {
    padding: 10,
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    fontSize: 14,
  } as React.CSSProperties,

  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as React.CSSProperties,
  gridMain: { display: "grid", gridTemplateColumns: "minmax(320px, 380px) minmax(0, 1fr)", gap: 12 } as React.CSSProperties,
  gridBottom: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, marginTop: 12 } as React.CSSProperties,


container: {
  width: "100%",
  maxWidth: 1280,      // 🔑 questo fa la magia
  margin: "0 auto",    // centratura orizzontale
  padding: "0 16px",    // respiro su mobile
} as React.CSSProperties,

};

const isNarrow = typeof window !== "undefined" && window.innerWidth < 980;

  return (
    <div style={S.page}>
      <div style={S.container}>
		{/* HEADER */}
      <div style={S.topbar}>
        <div>
          <h1 style={S.title}>MTG Tracker</h1>
          <div style={S.subtle}>Draft/Sealed · Girone (2 game) → Top4 → Playoff Bo3 · Punti = vittorie (game wins)</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={S.btn} onClick={exportJSON}>Export JSON</button>
          <label style={{ ...S.btn, display: "inline-flex", gap: 10, alignItems: "center" }}>
            Import JSON
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJSON(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {/* HALL OF FAME (always on top) */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Hall of Fame</div>
          <div style={S.subtle}>sx: classifica per nome · dx: tornei conclusi con vincitore</div>
        </div>

        <div style={{ ...S.grid2, marginTop: 10 }}>
          {/* Left: standings by name + cups left */}
          <div style={S.panel}>
          <div
            style={{
              ...S.panelHeader,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>Giocatori</span>
            <span style={{ ...S.chip, fontSize: 12, opacity: 0.85 }}>
              🏆 Tornei vinti · 🥈 Finali · ⭐ Top4
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>

              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th} />
                    <th style={S.th}>Nome</th>
                    <th style={S.th}>🏆</th>
                    <th style={S.th}>🥈</th>
                    <th style={S.th}>⭐</th>
                  </tr>
                </thead>
                <tbody>
                  {hall.rowsRanked.map((r, idx) => (
                    <tr key={r.id}>
                      <td style={{ ...S.td, width: 26, opacity: 0.9 }}>{trophyForRank(idx + 1)}</td>
                      <td style={{ ...S.td, fontWeight: 800 }}>{r.name}</td>
                      <td style={S.td}>{r.titles}</td>
                      <td style={S.td}>{r.finals}</td>
                      <td style={S.td}>{r.top4}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: tournaments with winner */}
          <div style={S.panel}>
            <div style={S.panelHeader}>Tornei conclusi</div>
            <div style={{ display: "grid", gap: 8, padding: 10 }}>
              {hall.tournamentsDone.length === 0 && (
                <div style={{ opacity: 0.75 }}>Nessun torneo concluso ancora.</div>
              )}
              {hall.tournamentsDone.map(t => (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: 10, borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)" }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>{t.name}</div>
                    <div style={{ opacity: 0.75, fontSize: 12 }}>{t.dateISO}</div>
                  </div>
                  <div style={{ ...S.chip, fontWeight: 900 }}>
                    🏆 {t.champion ? getPlayerName(state.players, t.champion) : "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* MAIN: Active tournaments left + selected tournament right */}
	  <div
	  style={
		isNarrow
		  ? { display: "grid", gridTemplateColumns: "1fr", gap: 12 }
		  : S.gridMain
	  }
	  >

        {/* LEFT: active tournaments */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>Tornei</div>
            <div style={S.subtle}>clicca per aprire</div>
          </div>

          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {activeTournaments.length === 0 && <div style={{ opacity: 0.75 }}>Nessun torneo ancora.</div>}
            {activeTournaments.map(t => {
              const isSel = t.id === selectedTournamentId;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTournamentId(t.id)}
                  style={{
                    ...S.btn,
                    textAlign: "left",
                    background: isSel
                      ? "linear-gradient(135deg, rgba(179, 18, 89, 0.45), rgba(122, 33, 210, 0.35))"
                      : "rgba(0,0,0,0.25)",
                    border: isSel ? "1px solid rgba(255,255,255,0.30)" : "1px solid rgba(255,255,255,0.12)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>{t.name}</div>
                    <div style={{ opacity: 0.8, fontWeight: 800 }}>
                      {t.stage === "done" ? "✅" : t.stage === "playoffs" ? "🔥" : "🎲"}
                    </div>
                  </div>
                  <div style={{ opacity: 0.75, fontSize: 12, marginTop: 2 }}>
                    {t.dateISO} · {prettyType(t.type)} · {t.stage === "roundrobin" ? "Girone" : t.stage === "playoffs" ? "Playoff" : "Finito"}
                    {t.winnerId ? ` · 🏆 ${getPlayerName(state.players, t.winnerId)}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* RIGHT: tournament detail */}
        <div style={S.card}>
          {!selectedTournament && (
            <div style={{ opacity: 0.8 }}>
              Seleziona un torneo a sinistra per inserire risultati.
            </div>
          )}

          {selectedTournament && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 18 }}>{selectedTournament.name}</div>
                  <div style={S.subtle}>
                    {selectedTournament.dateISO} · {prettyType(selectedTournament.type)} ·{" "}
                    {selectedTournament.stage === "roundrobin" ? "Girone (2 game)" : selectedTournament.stage === "playoffs" ? "Playoff (Bo3)" : "Finito"}
                    {selectedTournament.winnerId ? ` · 🏆 ${getPlayerName(state.players, selectedTournament.winnerId)}` : ""}
                  </div>
                </div>

                <label style={{ ...S.chip, cursor: "pointer" }}>
                  <input type="checkbox" checked={quickMode} onChange={() => setQuickMode(v => !v)} />
                  Quick Entry
                </label>
              </div>

              {/* Participants */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {selectedTournament.playerIds.map(pid => (
                  <span key={pid} style={S.chip}>{getPlayerName(state.players, pid)}</span>
                ))}
              </div>

              {/* Quick Entry panel */}
              {quickMode && selectedTournament.stage === "roundrobin" && (
                <div ref={quickRef} style={{ marginTop: 12, padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.20)", background: "rgba(0,0,0,0.25)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900 }}>⚡ Prossimo match</div>
                    <div style={{ opacity: 0.8, fontSize: 13 }}>
                      {rrDoneCount}/{selectedTournament.rrMatches.length}
                    </div>
                  </div>

                  {!nextPending ? (
                    <div style={{ marginTop: 8, opacity: 0.8 }}>
                      Girone completato ✅
                      <div style={{ marginTop: 8 }}>
                        <button style={{ ...S.btnPrimary, width: "100%" }} onClick={closeRoundRobinAndStartPlayoffs} disabled={!canCloseRR(selectedTournament)}>
                          Genera Playoff (Top4)
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center", marginTop: 10 }}>
                        <div style={{ fontWeight: 900, fontSize: 18 }}>{getPlayerName(state.players, nextPending.a)}</div>
                        <div style={{ opacity: 0.7 }}>vs</div>
                        <div style={{ fontWeight: 900, fontSize: 18, textAlign: "right" }}>{getPlayerName(state.players, nextPending.b)}</div>
                      </div>

                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                        <button style={{ ...S.btnPrimary, flex: 1, minWidth: 140 }} onClick={() => quickSet("2-0")}>2–0</button>
                        <button style={{ ...S.btnPrimary, flex: 1, minWidth: 140 }} onClick={() => quickSet("1-1")}>1–1</button>
                        <button style={{ ...S.btnPrimary, flex: 1, minWidth: 140 }} onClick={() => quickSet("0-2")}>0–2</button>
                      </div>
                      <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>Tap → salva → passa al match successivo.</div>
                    </>
                  )}
                </div>
              )}

              {/* Standings + Playoffs */}
              <div style={{ ...S.grid2, marginTop: 12 }}>
                {/* Standings */}
                <div style={S.panel}>
                  <div style={S.panelHeader}>Classifica Girone</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={S.table}>
                      <thead>
                        <tr>
                          <th style={S.th}>#</th>
                          <th style={S.th}>Giocatore</th>
                          <th style={S.th}>Punti</th>
                          <th style={S.th}>PF</th>
                          <th style={S.th}>PA</th>
                          <th style={S.th}>Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {standings.map((r, idx) => (
                          <tr key={r.id}>
                            <td style={S.td}>{idx + 1}</td>
                            <td style={{ ...S.td, fontWeight: idx < 4 ? 900 : 700 }}>
                              {r.name}{idx < 4 ? " ⭐" : ""}
                            </td>
                            <td style={{ ...S.td, fontWeight: 900 }}>{r.pts}</td>
                            <td style={S.td}>{r.pf}</td>
                            <td style={S.td}>{r.pa}</td>
                            <td style={S.td}>{r.diff}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ padding: 10, display: "grid", gap: 8 }}>
                    <div style={{ opacity: 0.75, fontSize: 12 }}>Tie-break: Punti → Diff → Nome.</div>
                    {selectedTournament.stage === "roundrobin" && (
  <>
    <button
      style={S.btn}
      onClick={() => setShowSeedOverride(v => !v)}
      disabled={!canCloseRR(selectedTournament)}
    >
      {showSeedOverride ? "Nascondi seeding manuale" : "Override Top4 / Seed (dopo spareggio)"}
    </button>

    {showSeedOverride && (
      <div style={{ ...S.row, marginTop: 10 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Seeding manuale (1–4)</div>
        <div style={{ opacity: 0.75, fontSize: 12, marginBottom: 10 }}>
          Default = Top4 automatico. Cambia l’ordine dopo lo spareggio (2 game) e poi genera i playoff.
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {[0, 1, 2, 3].map((i) => {
            const label = `Seed ${i + 1}`;
            const current = seedCurrent[i] ?? "";
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 10, alignItems: "center" }}>
                <div style={{ fontWeight: 900 }}>{label}</div>
                <select
                  value={current}
                  onChange={(e) => {
                    const val = e.target.value;
                    const base = (selectedTournament.seedOverride && selectedTournament.seedOverride.length === 4)
                      ? [...selectedTournament.seedOverride]
                      : [...top4Default];

                    // se base non è lunga 4 (edge), riempi con top4Default
                    while (base.length < 4) base.push(top4Default[base.length] ?? "");

                    base[i] = val;

                    // elimina eventuali duplicati “a cascata” (se scegli già usato)
                    // Manteniamo le altre selezioni ma garantiamo unicità sostituendo con candidati liberi
                    const used = new Set<ID>();
                    const cleaned: ID[] = [];
                    const candidates = selectedTournament.playerIds; // puoi scegliere QUALSIASI partecipante

                    for (let k = 0; k < 4; k++) {
                      const pick = base[k];
                      if (pick && !used.has(pick)) {
                        used.add(pick);
                        cleaned.push(pick);
                      } else {
                        // prendi il primo candidato libero
                        const free = candidates.find(c => !used.has(c));
                        if (free) {
                          used.add(free);
                          cleaned.push(free);
                        } else {
                          cleaned.push(base[k] || "");
                        }
                      }
                    }

                    updateTournament(selectedTournament.id, { seedOverride: cleaned });
                  }}
                  style={{ ...S.input }}
                >
                  {selectedTournament.playerIds.map(pid => (
                    <option key={pid} value={pid}>
                      {getPlayerName(state.players, pid)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 10, opacity: 0.8, fontSize: 12 }}>
          Semifinali generate: <b>1 vs 4</b> e <b>2 vs 3</b>.
        </div>

        <button
          style={{ ...S.btn, marginTop: 10 }}
          onClick={() => updateTournament(selectedTournament.id, { seedOverride: undefined })}
        >
          Reset seeding (torna automatico)
        </button>
      </div>
    )}

    <button style={{ ...S.btnPrimary, marginTop: 10 }} onClick={closeRoundRobinAndStartPlayoffs} disabled={!canCloseRR(selectedTournament)}>
      Chiudi girone e genera Playoff (Top4)
    </button>
  </>
)}

                  </div>
                </div>

				const top4Default = useMemo(() => {
				  if (!selectedTournament) return [];
				  return pickTop4(calcRRStandings(state.players, selectedTournament));
				}, [selectedTournament, state.players]);

				const seedCurrent = useMemo(() => {
				  if (!selectedTournament) return [];
				  const ov = selectedTournament.seedOverride;
				  if (ov && ov.length === 4 && new Set(ov).size === 4) return ov;
				  return top4Default;
				}, [selectedTournament, top4Default]);


                {/* Playoffs */}
                <div style={S.panel}>
                  <div style={{ padding: 10, fontWeight: 900, background: "rgba(0,0,0,0.25)" }}>Playoff</div>

                  {selectedTournament.stage === "roundrobin" && (
                    <div style={{ padding: 10, opacity: 0.75 }}>Completa il girone per generare semifinali/finale.</div>
                  )}

                  {selectedTournament.stage !== "roundrobin" && (
                    <div style={{ display: "grid", gap: 10, padding: 10 }}>
                      {selectedTournament.poMatches.map(m => (
                        <div key={m.id} style={{ padding: 10, borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)" }}>
                          <div style={{ fontWeight: 900 }}>{phaseLabel(m.phase)}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center", marginTop: 8 }}>
                            <div style={{ fontWeight: 900 }}>{getPlayerName(state.players, m.a)}</div>
                            <div style={{ opacity: 0.7 }}>vs</div>
                            <div style={{ fontWeight: 900, textAlign: "right" }}>{getPlayerName(state.players, m.b)}</div>
                          </div>

                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                            <span style={{ opacity: 0.8, fontSize: 12 }}>Bo3:</span>
                            <button style={S.btn} onClick={() => setPOWins(m.id, 2, 0)}>2-0</button>
                            <button style={S.btn} onClick={() => setPOWins(m.id, 2, 1)}>2-1</button>
                            <button style={S.btn} onClick={() => setPOWins(m.id, 1, 2)}>1-2</button>
                            <button style={S.btn} onClick={() => setPOWins(m.id, 0, 2)}>0-2</button>
                            <span style={{ marginLeft: "auto", fontWeight: 900 }}>{m.winsA}-{m.winsB} {m.done ? "✅" : ""}</span>
                          </div>

                          {m.phase === "F" && selectedTournament.winnerId && (
                            <div style={{ marginTop: 10, fontWeight: 900 }}>
                              🏆 Vincitore: {getPlayerName(state.players, selectedTournament.winnerId)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Full RR list */}
              <div style={{ marginTop: 12, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: 10, fontWeight: 900, background: "rgba(0,0,0,0.25)" }}>Girone — Lista completa</div>
                <div style={{ display: "grid", gap: 10, padding: 10 }}>
                  {selectedTournament.rrMatches.map(m => (
                    <div key={m.id} style={{ padding: 10, borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)", opacity: quickMode && !m.done ? 0.65 : 1 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center" }}>
                        <div style={{ fontWeight: 900 }}>{getPlayerName(state.players, m.a)}</div>
                        <div style={{ opacity: 0.7 }}>vs</div>
                        <div style={{ fontWeight: 900, textAlign: "right" }}>{getPlayerName(state.players, m.b)}</div>
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                        <button style={S.btn} onClick={() => setRRResult(m.id, 2, 0)}>2-0</button>
                        <button style={S.btn} onClick={() => setRRResult(m.id, 1, 1)}>1-1</button>
                        <button style={S.btn} onClick={() => setRRResult(m.id, 0, 2)}>0-2</button>

                        <span style={{ marginLeft: "auto", fontWeight: 900 }}>
                          {m.done ? `${m.winsA}-${m.winsB} ✅` : "—"}
                        </span>

                        {m.done && (
                          <button style={S.btn} onClick={() => unsetRR(m.id)}>Reset</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* BOTTOM: players left, new tournament right */}
      <div
        style={
          isNarrow
            ? { display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 }
            : S.gridBottom
        }
      >

        {/* Players */}
        <div style={S.card}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Giocatori</div>

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              style={S.input}
              value={newPlayerName}
              onChange={(e) => setNewPlayerName(e.target.value)}
              placeholder="Nuovo giocatore"
            />
            <button style={S.btnPrimary} onClick={() => { addPlayer(newPlayerName); setNewPlayerName(""); }}>
              Aggiungi
            </button>
          </div>

          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {playersSorted.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.18)" }}>
                <input type="checkbox" checked={p.active} onChange={() => togglePlayerActive(p.id)} />
                <input style={{ ...S.input, padding: 8 }} value={p.name} onChange={(e) => renamePlayer(p.id, e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        {/* New tournament */}
        <div style={S.card}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Nuovo torneo</div>

          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <input style={S.input} value={newTName} onChange={(e) => setNewTName(e.target.value)} placeholder="Nome (es. 14' Draft - KTK)" />

            <div style={{ display: "flex", gap: 10 }}>
              <input style={S.input} type="date" value={newTDate} onChange={(e) => setNewTDate(e.target.value)} />
              <select
                value={newTType}
                onChange={(e) => setNewTType(e.target.value as TournamentType)}
                style={{ ...S.input, width: 160 }}
              >
                <option value="draft">Draft</option>
                <option value="sealed">Sealed</option>
              </select>
            </div>

            <div style={S.panel}>
              <div style={S.panelHeader}>Partecipanti (min 4)</div>
			  <div style={{ padding: 10, display: "grid", gap: 6 }}>
                {playersSorted.map(p => (
                  <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", opacity: p.active ? 1 : 0.65 }}>
                    <input
                      type="checkbox"
                      checked={!!newTSelected[p.id]}
                      onChange={() => setNewTSelected(s => ({ ...s, [p.id]: !s[p.id] }))}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>

            <button
              style={{ ...S.btnPrimary, opacity: selectedPlayersForNew.length < 4 || !newTName.trim() ? 0.5 : 1 }}
              disabled={selectedPlayersForNew.length < 4 || !newTName.trim()}
              onClick={() => {
                createTournament({
                  name: newTName,
                  dateISO: newTDate,
                  type: newTType,
                  playerIds: selectedPlayersForNew.map(p => p.id),
                });
                setNewTName("");
              }}
            >
              Crea torneo
            </button>

            <div style={{ opacity: 0.7, fontSize: 12 }}>
              Tip: dopo ogni torneo → Export JSON (backup WhatsApp/Drive).
            </div>
          </div>
        </div>
      </div>
	  </div>
    </div>
  );
}
