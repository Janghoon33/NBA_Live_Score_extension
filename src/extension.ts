import * as vscode from 'vscode';
import * as https from 'https';
import { getPlayerNameKo } from './playerNames';

function getTodayParam(): string {
  // ESPN API uses US Eastern Time (UTC-5). Convert UTC to ET before extracting date.
  const etTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return `${etTime.getUTCFullYear()}${String(etTime.getUTCMonth() + 1).padStart(2, '0')}${String(etTime.getUTCDate()).padStart(2, '0')}`;
}

const ESPN_SCOREBOARD_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=';
const ESPN_SUMMARY_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=';

// ── Intervals ─────────────────────────────────────────────────
const SCORE_INTERVAL_MS = 20_000;  // 20s: scoreboard
const PLAY_INTERVAL_MS  =  6_000;  // 6s: play-by-play (selected live games only)
const FINAL_PLAY_RETENTION_MS = 5 * 60_000; // 5m: keep final-game plays visible

// ── Interfaces ────────────────────────────────────────────────
interface EspnTeam {
  id: string;
  abbreviation: string;
  displayName: string;
  logo: string;
}
interface EspnCompetitor { team: EspnTeam; score: string; homeAway: string; }
interface EspnStatus {
  type: { name: string; shortDetail: string };
  displayClock: string;
  period: number;
}
interface EspnCompetition {
  competitors: EspnCompetitor[];
  status: EspnStatus;
  venue?: { fullName: string; address?: { city: string; state: string } };
}
interface EspnEvent { id: string; date: string; competitions: EspnCompetition[]; }
interface EspnResponse { events: EspnEvent[]; }

interface EspnPlay {
  text?: string;
  type?: { text?: string };
  scoringPlay?: boolean;
  scoreValue?: number;
  participants?: Array<{ athlete?: { id?: string; displayName?: string; shortName?: string } }>;
  athletesInvolved?: Array<{ displayName?: string }>;
  team?: { id?: string };
  period?: { number?: number } | number;
  clock?: { displayValue?: string };
}

// ── HTTP helper ───────────────────────────────────────────────
function fetchData<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

// ── Player Stats ──────────────────────────────────────────────
interface PlayerStats { name: string; starter: boolean; stats: Record<string, string>; }
interface TeamStats   { abbr: string; players: PlayerStats[]; }
interface GameStats   { away: TeamStats; home: TeamStats; }

// Columns to display (ESPN label → Korean header / English header)
const STAT_COLS: { key: string; ko: string; en: string }[] = [
  { key: 'MIN',  ko: '출전', en: 'MIN' },
  { key: 'PTS',  ko: '득점', en: 'PTS' },
  { key: 'REB',  ko: '리바', en: 'REB' },
  { key: 'AST',  ko: '어시', en: 'AST' },
  { key: 'STL',  ko: '스틸', en: 'STL' },
  { key: 'BLK',  ko: '블록', en: 'BLK' },
  { key: 'FG',   ko: '야투', en: 'FG'  },
  { key: 'FG%',  ko: '야투%',en: 'FG%' },
  { key: '3PT',  ko: '3점',  en: '3PT' },
  { key: 'FT',   ko: '자투', en: 'FT'  },
  { key: 'FT%',  ko: '자투%',en: 'FT%' },
  { key: 'OREB', ko: '공리', en: 'OREB'},
  { key: 'DREB', ko: '수리', en: 'DREB'},
  { key: 'TO',   ko: '턴오', en: 'TO'  },
  { key: 'PF',   ko: '파울', en: 'PF'  },
  { key: '+/-',  ko: '+/-',  en: '+/-' },
];

function parseMakeAtt(s: string): [number, number] {
  const parts = (s ?? '').split('-').map(Number);
  return [isFinite(parts[0]) ? parts[0] : 0, isFinite(parts[1]) ? parts[1] : 0];
}
function fmtPct(made: number, att: number): string {
  if (att === 0) return '-';
  return (Math.round(made / att * 1000) / 10).toFixed(1) + '%';
}

async function fetchStats(eventId: string): Promise<GameStats | null> {
  try {
    const json: any = await fetchData(ESPN_SUMMARY_BASE + eventId);
    const teamStats: any[] = json.boxscore?.players ?? [];
    if (teamStats.length === 0) return null;

    const extractTeam = (teamData: any): TeamStats => {
      const abbr: string = teamData.team?.abbreviation ?? '';
      const stats: any = teamData.statistics?.[0] ?? {};
      const labels: string[] = stats.labels ?? stats.names ?? [];
      const athletes: any[] = stats.athletes ?? [];

      const players: PlayerStats[] = athletes.map((a: any) => {
        const rawStats: string[] = a.stats ?? [];
        const statMap: Record<string, string> = {};
        labels.forEach((lbl: string, i: number) => { statMap[lbl] = rawStats[i] ?? '-'; });
        // Compute FG% and FT% from made-attempted strings
        const [fgm, fga] = parseMakeAtt(statMap['FG'] ?? '');
        const [ftm, fta] = parseMakeAtt(statMap['FT'] ?? '');
        statMap['FG%'] = fmtPct(fgm, fga);
        statMap['FT%'] = fmtPct(ftm, fta);
        // Normalize FG / 3PT / FT display to "m/a"
        if (statMap['FG'])  statMap['FG']  = statMap['FG'].replace('-', '/');
        if (statMap['3PT']) statMap['3PT'] = statMap['3PT'].replace('-', '/');
        if (statMap['FT'])  statMap['FT']  = statMap['FT'].replace('-', '/');
        return {
          name:    a.athlete?.displayName ?? '?',
          starter: a.starter === true,
          stats:   statMap,
        };
      });

      // Sort: starters first, then bench; sort by PTS desc within each group
      const starters = players.filter(p => p.starter);
      const bench    = players.filter(p => !p.starter);
      const byPts    = (a: PlayerStats, b: PlayerStats) =>
        (parseInt(b.stats['PTS'] ?? '0') || 0) - (parseInt(a.stats['PTS'] ?? '0') || 0);
      return { abbr, players: [...starters.sort(byPts), ...bench.sort(byPts)] };
    };

    const awayData = teamStats.find((t: any) => t.homeAway === 'away') ?? teamStats[0];
    const homeData = teamStats.find((t: any) => t.homeAway === 'home') ?? teamStats[1];
    if (!awayData) return null;

    return { away: extractTeam(awayData), home: extractTeam(homeData ?? awayData) };
  } catch { return null; }
}

async function fetchPlays(eventId: string): Promise<{ plays: EspnPlay[]; roster: Map<string, string> }> {
  try {
    const json: any = await fetchData(ESPN_SUMMARY_BASE + eventId);
    const arr: any[] = Array.isArray(json.plays)
      ? json.plays
      : (json.plays?.items ?? []);
    const plays = arr
      .filter((p: any) => {
        if (!p.text?.trim()) { return false; }
        // Team rebounds are not credited to any player — skip them
        const t = p.text.toLowerCase();
        if (t.includes('team rebound') || t.includes('team offensive rebound')) { return false; }
        return true;
      })
      .slice(-15).reverse();

    // Build athleteId → teamId map from roster data (more reliable than play.team.id)
    const roster = new Map<string, string>();
    for (const r of (json.rosters ?? [])) {
      const teamId = String(r.team?.id ?? '');
      for (const a of (r.athletes ?? [])) {
        const athleteId = String(a.athlete?.id ?? a.id ?? '');
        if (athleteId && teamId) { roster.set(athleteId, teamId); }
      }
    }

    return { plays, roster };
  } catch {
    return { plays: [], roster: new Map() };
  }
}

// ── Play display helpers ──────────────────────────────────────
interface PlayDisplay {
  emoji: string;
  label: string;
  labelKo: string;
  labelClass: string;
  descKo: string;
}

function classifyPlay(play: EspnPlay): PlayDisplay {
  const t = ((play.text || '') + ' ' + (play.type?.text || '')).toLowerCase();
  const scoring = play.scoringPlay ?? false;

  // 3-pointers
  if (t.includes('three point') || t.includes('3-point') || t.includes('3 point')) {
    if (t.includes('makes') || scoring) return { emoji: '🤟', label: 'THREE!',   labelKo: '3점슛!',    labelClass: 'three', descKo: '3점슛 성공' };
    return                               { emoji: '❌', label: '3PT MISS', labelKo: '3점슛 실패',  labelClass: 'miss',  descKo: '3점슛 실패' };
  }
  // Free throws
  if (t.includes('free throw')) {
    if (t.includes('makes') || scoring) return { emoji: '☝️', label: 'FT',      labelKo: '자유투',    labelClass: 'ft',    descKo: '자유투 성공' };
    return                               { emoji: '❌', label: 'FT MISS',  labelKo: 'FT 실패',   labelClass: 'miss',  descKo: '자유투 실패' };
  }
  // Dunks / Layups / Makes
  if (t.includes('dunk'))
    return { emoji: '💥', label: 'DUNK',      labelKo: '덩크',      labelClass: 'score', descKo: '덩크슛 성공' };
  if (t.includes('layup') && (t.includes('makes') || scoring))
    return { emoji: '🏀', label: 'LAYUP',     labelKo: '레이업',    labelClass: 'score', descKo: '레이업 성공' };
  if (t.includes('alley oop'))
    return { emoji: '🤸', label: 'ALLEY-OOP', labelKo: '앨리웁',    labelClass: 'score', descKo: '앨리웁 성공' };
  if (scoring || t.includes('makes'))
    return { emoji: '🏀', label: '2PT',       labelKo: '2점슛',     labelClass: 'score', descKo: '필드골 성공' };
  // Misses
  if (t.includes('misses') || t.includes('miss')) {
    if (t.includes('jump shot') || t.includes('jumper')) {
      const is3 = t.includes('three') || t.includes('3-point') || t.includes('3 point');
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: is3 ? '3pt 점프슛 실패' : '2pt 점프슛 실패' };
    }
    if (t.includes('layup'))
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '레이업 실패' };
    if (t.includes('hook'))
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '훅슛 실패' };
    if (t.includes('pullup') || t.includes('pull-up') || t.includes('pull up'))
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '풀업 실패' };
    if (t.includes('fadeaway') || t.includes('fade away'))
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '페이드어웨이 실패' };
    if (t.includes('step back') || t.includes('stepback'))
      return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '스텝백 실패' };
    return { emoji: '❌', label: 'MISS', labelKo: '실패', labelClass: 'miss', descKo: '슛 실패' };
  }
  // Rebounds
  if (t.includes('offensive rebound'))
    return { emoji: '💪', label: 'OFF REB',   labelKo: '공격리바',  labelClass: 'reb',   descKo: '공격 리바운드' };
  if (t.includes('rebound'))
    return { emoji: '🫳', label: 'REB',       labelKo: '리바운드',  labelClass: 'reb',   descKo: '수비 리바운드' };
  // Turnovers (split by subtype for better Korean) — must check before 'steal' since bad pass text contains "(X steals)"
  if (t.includes('bad pass'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '패스 실수' };
  if (t.includes('lost ball'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '볼 분실' };
  if (t.includes('offensive charge') || t.includes('charge'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '오펜시브 차지' };
  if (t.includes('traveling') || t.includes('travel'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '트래블링' };
  if (t.includes('out of bounds') || t.includes('out-of-bounds'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '아웃 오브 바운즈' };
  if (t.includes('turnover'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '턴오버' };
  // Defense
  if (t.includes('steal'))
    return { emoji: '✊', label: 'STEAL',     labelKo: '스틸',      labelClass: 'def',   descKo: '볼 스틸' };
  if (t.includes('block'))
    return { emoji: '🚫', label: 'BLOCK',     labelKo: '블록',      labelClass: 'def',   descKo: '블록슛' };
  // Fouls (split by subtype)
  if (t.includes('technical'))
    return { emoji: '✋', label: 'FOUL',      labelKo: '파울',      labelClass: 'foul',  descKo: '테크니컬 파울' };
  if (t.includes('flagrant'))
    return { emoji: '✋', label: 'FOUL',      labelKo: '파울',      labelClass: 'foul',  descKo: '플래그런트 파울' };
  if (t.includes('foul'))
    return { emoji: '✋', label: 'FOUL',      labelKo: '파울',      labelClass: 'foul',  descKo: '개인 파울' };
  // Game flow
  if (t.includes('timeout'))
    return { emoji: '⏸️', label: 'TIMEOUT',  labelKo: '타임아웃',  labelClass: 'misc',  descKo: '팀 타임아웃' };
  if (t.includes('end of')) {
    let descKo = '쿼터 종료';
    if      (t.includes('1st') || t.includes('first'))  descKo = '1쿼터 종료';
    else if (t.includes('2nd') || t.includes('second')) descKo = '2쿼터 종료';
    else if (t.includes('3rd') || t.includes('third'))  descKo = '3쿼터 종료';
    else if (t.includes('4th') || t.includes('fourth')) descKo = '4쿼터 종료';
    else if (t.includes('half'))                         descKo = '전반 종료';
    else if (t.includes('game') || t.includes('regulation')) descKo = '경기 종료';
    else if (t.includes('overtime') || t.includes(' ot')) descKo = '연장 종료';
    return { emoji: '🔔', label: '', labelKo: '', labelClass: 'misc', descKo };
  }
  if (t.includes('jump ball') || t.includes('jumpball'))
    return { emoji: '⚡', label: 'JUMP BALL', labelKo: '점프볼',    labelClass: 'misc',  descKo: '점프볼' };
  if (t.includes('violation'))
    return { emoji: '🚷', label: 'VIOLATION', labelKo: '바이얼레이션', labelClass: 'misc', descKo: '룰 위반' };
  if (t.includes("coach's challenge") || t.includes('challenge'))
    return { emoji: '📋', label: 'CHALLENGE', labelKo: '챌린지',    labelClass: 'misc', descKo: '코치 챌린지' };
  if (t.includes('replay') || t.includes('official'))
    return { emoji: '📺', label: 'REVIEW',    labelKo: '비디오 판독', labelClass: 'misc', descKo: '비디오 판독' };
  // Substitution
  if (t.includes('enters the game') || t.includes('enters game'))
    return { emoji: '🔁', label: 'IN',        labelKo: '투입',      labelClass: 'sub',  descKo: '선수 투입' };

  return { emoji: '▸', label: '', labelKo: '', labelClass: 'misc', descKo: play.text?.slice(0, 30) || '' };
}

function getPlayPeriod(play: EspnPlay): string {
  const p = typeof play.period === 'object' ? play.period?.number : play.period;
  if (!p) return '';
  return p > 4 ? `OT${p - 4}` : `Q${p}`;
}

function getPlayClock(play: EspnPlay): string {
  return play.clock?.displayValue ?? '';
}

function extractPlayerFromText(text: string): string {
  if (!text) { return ''; }
  // Team/game actions with no specific player
  if (/^(team|jump ball|end of|start of|timeout|period|quarter|halftime|replay|official)/i.test(text)) { return ''; }
  // Team-name prefixed events (e.g. "Spurs Coach's Challenge")
  if (/coach'?s/i.test(text)) { return ''; }

  const words = text.split(' ');
  if (words.length < 2) { return ''; }

  // Most player names are 2 words (First Last). Both should start with uppercase.
  const first = words[0];
  const second = words[1];
  // Skip if first word is an action keyword
  if (/^(defensive|offensive|personal|technical|flagrant|free|jump|end|start|makes|misses)/i.test(first)) {
    return '';
  }
  if (/^[A-Z]/.test(first) && /^[A-Z']/.test(second)) {
    // Handle 3-word names like "Kelly Oubre Jr." where 3rd word is "Jr." or "II" etc.
    const third = words[2];
    if (third && /^(Jr\.|Sr\.|II|III|IV)$/.test(third)) {
      return `${first} ${second} ${third}`;
    }
    return `${first} ${second}`;
  }
  // Handle names with lowercase middle parts (e.g. "Tristan da Silva", "Shai Gilgeous-Alexander")
  if (/^[A-Z]/.test(first) && words.length >= 3) {
    // Find the last uppercase-starting word that completes the name
    for (let i = 2; i < Math.min(words.length, 4); i++) {
      if (/^[A-Z]/.test(words[i])) {
        const suffix = words[i + 1];
        if (suffix && /^(Jr\.|Sr\.|II|III|IV)$/.test(suffix)) {
          return words.slice(0, i + 2).join(' ');
        }
        return words.slice(0, i + 1).join(' ');
      }
    }
  }
  return '';
}

function getPlayerName(play: EspnPlay): string {
  return (
    (play as any).participants?.[0]?.athlete?.displayName ||
    (play as any).participants?.[0]?.athlete?.shortName ||
    (play as any).participants?.[0]?.displayName ||
    (play as any).athletes?.[0]?.displayName ||
    play.athletesInvolved?.[0]?.displayName ||
    extractPlayerFromText(play.text || '')
  );
}

function extractSubPlayers(play: EspnPlay): { inPlayer: string; outPlayer: string } {
  const inPlayer =
    (play as any).participants?.[0]?.athlete?.displayName ||
    (play as any).athletes?.[0]?.displayName ||
    play.athletesInvolved?.[0]?.displayName || '';
  const outPlayer =
    (play as any).participants?.[1]?.athlete?.displayName ||
    (play as any).athletes?.[1]?.displayName ||
    play.athletesInvolved?.[1]?.displayName || '';

  if (!outPlayer && play.text) {
    const m = play.text.match(/enters (?:the )?game for (.+)/i);
    if (m) {
      return { inPlayer: inPlayer || extractPlayerFromText(play.text), outPlayer: m[1].trim() };
    }
  }
  return { inPlayer: inPlayer || extractPlayerFromText(play.text || ''), outPlayer };
}

// ── i18n ─────────────────────────────────────────────────────
type Lang = 'ko' | 'en';
const T = {
  ko: {
    loading:        '불러오는 중...',
    error:          '오류 발생',
    retry:          '다시 시도',
    noGames:        '오늘 경기 없음',
    todayGames:     (n: number) => `오늘 ${n}경기`,
    watching:       (n: number) => `★ ${n}경기 시청 중`,
    selectHint:     '☆ 경기를 선택하세요',
    final:          '경기종료',
    scheduled:      '예정',
    home:           '홈',
    addGame:        '경기 추가',
    removeGame:     '관심 해제',
    refresh:        '새로고침',
    fetchingPlays:  '중계 데이터 불러오는 중...',
    gameStart:      (t: string) => `경기 시작: ${t}`,
    autoFeed:       '시작 후 자동으로 중계가 표시됩니다',
    gameOver:       '경기 종료',
    stats:          '기록',
    statsLoading:   '기록 불러오는 중...',
    statsNone:      '기록 정보 없음',
    starterLabel:   '선발',
    benchLabel:     '벤치',
  },
  en: {
    loading:        'Loading...',
    error:          'Error',
    retry:          'Retry',
    noGames:        'No games today',
    todayGames:     (n: number) => `${n} game${n !== 1 ? 's' : ''} today`,
    watching:       (n: number) => `★ Watching ${n} game${n !== 1 ? 's' : ''}`,
    selectHint:     '☆ Select a game to watch',
    final:          'Final',
    scheduled:      'Scheduled',
    home:           'Home',
    addGame:        'Watch this game',
    removeGame:     'Remove',
    refresh:        'Refresh',
    fetchingPlays:  'Loading play-by-play...',
    gameStart:      (t: string) => `Tip-off: ${t}`,
    autoFeed:       'Live feed will appear after tip-off',
    gameOver:       'Game over',
    stats:          'Stats',
    statsLoading:   'Loading stats...',
    statsNone:      'Stats not available',
    starterLabel:   'Starters',
    benchLabel:     'Bench',
  },
} as const;

// ── Provider ──────────────────────────────────────────────────
export class NbaScoreViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nbaScoreView';
  private _view?: vscode.WebviewView;
  private _scoreTimer?: NodeJS.Timeout;
  private _playTimer?: NodeJS.Timeout;
  private _finalPlayTimer?: NodeJS.Timeout;
  private _selectedGames: Set<string>;
  private _events: EspnEvent[] = [];
  private _playMap = new Map<string, EspnPlay[]>();
  private _rosterMap = new Map<string, Map<string, string>>(); // eventId → athleteId → teamId
  private _lastPlayText = new Map<string, string>(); // eventId -> most recent play text
  private _newPlayEventIds = new Set<string>();       // games with a freshly arrived play
  private _finalPlayRetainUntil = new Map<string, number>(); // eventId -> timestamp
  private _finalPlaysFetched = new Set<string>();            // eventId -> final plays fetched once
  private _statsMap = new Map<string, GameStats | null>();  // eventId -> stats (null = no data)
  private _statsLoading = new Set<string>();                // eventId -> currently fetching
  private _expandedStats = new Set<string>();              // eventId -> stats panel open
  private _finalStatsUpdated = new Set<string>();          // eventId -> final stats fetched once
  private _lang: Lang;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    const savedDate = _context.globalState.get<string>('nba.selectedDate', '');
    const today = getTodayParam();
    const saved = savedDate === today
      ? _context.globalState.get<string[]>('nba.selectedGames', [])
      : [];
    this._selectedGames = new Set(saved);
    this._lang = _context.globalState.get<Lang>('nba.lang', 'ko');
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this._getLoadingHtml();
    this._refresh();

    webviewView.onDidDispose(() => {
      if (this._scoreTimer) { clearTimeout(this._scoreTimer); }
      if (this._playTimer)  { clearTimeout(this._playTimer); }
      if (this._finalPlayTimer) { clearTimeout(this._finalPlayTimer); }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh') { this._refresh(); }
      if (msg.command === 'toggleGame') { await this._toggleGame(msg.eventId); }
      if (msg.command === 'toggleStats') { await this._toggleStats(msg.eventId); }
      if (msg.command === 'setLang') {
        this._lang = msg.lang as Lang;
        await this._context.globalState.update('nba.lang', this._lang);
        this._render();
      }
    });
  }

  public refresh() { this._refresh(); }

  // ── Timer helpers ────────────────────────────────────────────
  private _scheduleScoreNext(hasActiveGames: boolean) {
    if (this._scoreTimer) { clearTimeout(this._scoreTimer); this._scoreTimer = undefined; }
    if (hasActiveGames) {
      this._scoreTimer = setTimeout(() => this._refreshScores(), SCORE_INTERVAL_MS);
    }
  }

  private _schedulePlaysNext(hasLiveSelected: boolean) {
    if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = undefined; }
    if (hasLiveSelected) {
      this._playTimer = setTimeout(() => this._refreshPlays(), PLAY_INTERVAL_MS);
    }
  }

  private _scheduleFinalPlayClear() {
    if (this._finalPlayTimer) {
      clearTimeout(this._finalPlayTimer);
      this._finalPlayTimer = undefined;
    }
    const now = Date.now();
    const nextExpiry = Math.min(
      ...[...this._finalPlayRetainUntil.values()].filter((until) => until > now)
    );
    if (Number.isFinite(nextExpiry)) {
      this._finalPlayTimer = setTimeout(() => {
        this._expireFinalPlayRetention();
        this._render();
        this._scheduleFinalPlayClear();
      }, Math.max(0, nextExpiry - now));
    }
  }

  private _expireFinalPlayRetention(now = Date.now()) {
    for (const [id, retainUntil] of this._finalPlayRetainUntil) {
      if (retainUntil <= now) {
        this._finalPlayRetainUntil.delete(id);
      }
    }
  }

  private _liveSelectedEvents(): EspnEvent[] {
    return this._events.filter((e) => {
      if (!this._selectedGames.has(e.id)) { return false; }
      const s = e.competitions[0]?.status?.type?.name;
      // Include halftime, end-of-period, etc. — anything that isn't final or scheduled
      return s !== 'STATUS_FINAL' && s !== 'STATUS_SCHEDULED';
    });
  }

  private _getEventStatus(eventId: string): string {
    return this._events.find((e) => e.id === eventId)?.competitions[0]?.status?.type?.name ?? '';
  }

  private _isFinalPlayRetained(eventId: string): boolean {
    const retainUntil = this._finalPlayRetainUntil.get(eventId) ?? 0;
    return retainUntil > Date.now();
  }

  private async _refreshFinalSelectedPlays(): Promise<void> {
    this._expireFinalPlayRetention();
    const finalSelected = this._events.filter((e) =>
      this._selectedGames.has(e.id) &&
      e.competitions[0]?.status?.type?.name === 'STATUS_FINAL' &&
      !this._finalPlaysFetched.has(e.id)
    );
    if (finalSelected.length === 0) {
      this._scheduleFinalPlayClear();
      return;
    }

    const results = await Promise.all(finalSelected.map((e) => fetchPlays(e.id)));
    finalSelected.forEach((e, i) => {
      const { plays, roster } = results[i];
      this._playMap.set(e.id, plays);
      this._rosterMap.set(e.id, roster);
      this._lastPlayText.set(e.id, plays[0]?.text ?? '');
      this._finalPlaysFetched.add(e.id);
      if (plays.length > 0 && !this._finalPlayRetainUntil.has(e.id)) {
        this._finalPlayRetainUntil.set(e.id, Date.now() + FINAL_PLAY_RETENTION_MS);
      }
    });
    this._scheduleFinalPlayClear();
  }

  // Fetch and store stats for given ids; mark FINAL ones in _finalStatsUpdated
  private async _updateStatsFor(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const results = await Promise.all(ids.map((id) => fetchStats(id)));
    ids.forEach((id, i) => {
      this._statsMap.set(id, results[i]);
      if (this._getEventStatus(id) === 'STATUS_FINAL') {
        this._finalStatsUpdated.add(id);
      }
    });
  }

  // ── Toggle ────────────────────────────────────────────────────
  private async _toggleGame(eventId: string) {
    if (this._selectedGames.has(eventId)) {
      // Remove: update state and render immediately — no async before render
      this._selectedGames.delete(eventId);
      this._playMap.delete(eventId);
      this._rosterMap.delete(eventId);
      this._lastPlayText.delete(eventId);
      this._finalPlayRetainUntil.delete(eventId);
      this._finalPlaysFetched.delete(eventId);
      this._scheduleFinalPlayClear();
      this._render();
    } else {
      // Add: show star on instantly, then load plays
      this._selectedGames.add(eventId);
      this._render();
      const ev = this._events.find((e) => e.id === eventId);
      const evStatus = ev?.competitions[0]?.status?.type?.name;
      if (evStatus && evStatus !== 'STATUS_FINAL' && evStatus !== 'STATUS_SCHEDULED') {
        const { plays, roster } = await fetchPlays(eventId);
        this._playMap.set(eventId, plays);
        this._rosterMap.set(eventId, roster);
        this._lastPlayText.set(eventId, plays[0]?.text ?? '');
        // Start play timer if not already running
        if (!this._playTimer) { this._schedulePlaysNext(true); }
        this._render();
      }
    }
    // Persist asynchronously after UI has already updated
    this._context.globalState.update('nba.selectedGames', [...this._selectedGames]);
    this._context.globalState.update('nba.selectedDate', getTodayParam());
  }

  // ── Stats toggle ──────────────────────────────────────────────
  private async _toggleStats(eventId: string) {
    if (this._expandedStats.has(eventId)) {
      this._expandedStats.delete(eventId);
      this._render();
      return;
    }
    this._expandedStats.add(eventId);
    // Always fetch fresh stats when opening the panel
    this._statsLoading.add(eventId);
    this._render();
    const stats = await fetchStats(eventId);
    this._statsMap.set(eventId, stats);
    this._statsLoading.delete(eventId);
    this._render();
  }

  // ── Full refresh (initial + manual) ──────────────────────────
  private async _refresh() {
    if (!this._view) return;
    if (this._scoreTimer) { clearTimeout(this._scoreTimer); this._scoreTimer = undefined; }
    if (this._playTimer)  { clearTimeout(this._playTimer);  this._playTimer = undefined; }
    try {
      const url = ESPN_SCOREBOARD_BASE + getTodayParam();
      const data = await fetchData<EspnResponse>(url);
      this._events = data.events || [];

      const validIds = new Set(this._events.map((e) => e.id));
      for (const id of this._selectedGames) {
        if (!validIds.has(id)) {
          this._selectedGames.delete(id);
          this._playMap.delete(id);
          this._rosterMap.delete(id);
          this._lastPlayText.delete(id);
          this._finalPlayRetainUntil.delete(id);
          this._finalPlaysFetched.delete(id);
        }
      }

      // On manual refresh: update plays for all selected games, regardless of status
      const allSelected = [...this._selectedGames]
        .map((id) => this._events.find((e) => e.id === id))
        .filter((e) => !!e) as EspnEvent[];
      if (allSelected.length > 0) {
        const results = await Promise.all(allSelected.map((e) => fetchPlays(e.id)));
        allSelected.forEach((e, i) => {
          this._playMap.set(e.id, results[i].plays);
          this._rosterMap.set(e.id, results[i].roster);
          this._lastPlayText.set(e.id, results[i].plays[0]?.text ?? '');
        });
      }

      const liveSelected = this._liveSelectedEvents();
      await this._refreshFinalSelectedPlays();

      // Update stats for all expanded panels on full refresh, regardless of status
      const expandedToUpdate = [...this._expandedStats];
      await this._updateStatsFor(expandedToUpdate);

      this._render();

      const hasActive = this._events.some(
        (e) => e.competitions[0]?.status?.type?.name !== 'STATUS_FINAL'
      );
      this._scheduleScoreNext(hasActive);
      this._schedulePlaysNext(liveSelected.length > 0);
    } catch (err) {
      if (this._view) { this._view.webview.html = this._getErrorHtml(String(err)); }
      this._scheduleScoreNext(false);
      this._schedulePlaysNext(false);
    }
  }

  // ── Score-only refresh (every 20s) ────────────────────────────
  private async _refreshScores() {
    if (!this._view) return;
    try {
      const url = ESPN_SCOREBOARD_BASE + getTodayParam();
      const data = await fetchData<EspnResponse>(url);
      this._events = data.events || [];

      const validIds = new Set(this._events.map((e) => e.id));
      for (const id of this._selectedGames) {
        if (!validIds.has(id)) {
          this._selectedGames.delete(id);
          this._playMap.delete(id);
          this._rosterMap.delete(id);
          this._lastPlayText.delete(id);
          this._finalPlayRetainUntil.delete(id);
          this._finalPlaysFetched.delete(id);
        }
      }

      await this._refreshFinalSelectedPlays();

      // Update stats for all expanded panels every 20s (fav + non-fav), final games get one last update
      const expandedToUpdate = [...this._expandedStats].filter((id) => {
        const status = this._getEventStatus(id);
        if (status === 'STATUS_FINAL') return !this._finalStatsUpdated.has(id);
        return status === 'STATUS_IN_PROGRESS';
      });
      await this._updateStatsFor(expandedToUpdate);

      this._render();

      const hasActive = this._events.some(
        (e) => e.competitions[0]?.status?.type?.name !== 'STATUS_FINAL'
      );
      this._scheduleScoreNext(hasActive);

      // Ensure play timer starts if live selected games appeared
      const hasLiveSelected = this._liveSelectedEvents().length > 0;
      if (hasLiveSelected && !this._playTimer) {
        this._schedulePlaysNext(true);
      }
    } catch {
      this._scheduleScoreNext(true);
    }
  }

  // ── Play-only refresh (every 6s) ──────────────────────────────
  private async _refreshPlays() {
    if (!this._view) return;
    try {
      const liveSelected = this._liveSelectedEvents();
      if (liveSelected.length === 0) {
        this._schedulePlaysNext(false);
        return;
      }

      const results = await Promise.all(liveSelected.map((e) => fetchPlays(e.id)));

      let changed = false;
      this._newPlayEventIds.clear();
      liveSelected.forEach((e, i) => {
        const { plays: newPlays, roster } = results[i];
        const newFirst = newPlays[0]?.text ?? '';
        const oldFirst = this._lastPlayText.get(e.id) ?? '';
        if (newFirst !== oldFirst) {
          changed = true;
          this._newPlayEventIds.add(e.id);
          this._lastPlayText.set(e.id, newFirst);
          this._playMap.set(e.id, newPlays);
          this._rosterMap.set(e.id, roster);
        }
      });

      // Update stats every 6s for favorited live games with expanded stats panel
      const favExpandedLiveIds = liveSelected
        .map((e) => e.id)
        .filter((id) => this._expandedStats.has(id));
      await this._updateStatsFor(favExpandedLiveIds);

      if (changed || favExpandedLiveIds.length > 0) { this._render(); }
      this._schedulePlaysNext(true);
    } catch {
      this._schedulePlaysNext(true);
    }
  }

  private _render() {
    if (!this._view) return;
    this._view.webview.html = this._getWebviewContent();
    this._newPlayEventIds.clear();
  }

  // ── HTML ──────────────────────────────────────────────────
  private _getLoadingHtml(): string {
    const t = T[this._lang];
    return `<!DOCTYPE html><html><body style="background:#1a1a1a;color:#555;font-family:sans-serif;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:12px;">
      <div style="text-align:center"><div style="font-size:26px">🏀</div>
      <div style="margin-top:5px">${t.loading}</div></div></body></html>`;
  }

  private _getErrorHtml(err: string): string {
    const t = T[this._lang];
    return `<!DOCTYPE html><html><body style="background:#1a1a1a;color:#ccc;padding:12px;font-family:sans-serif;font-size:11px;">
      <div style="color:#f48771">${t.error}</div>
      <div style="color:#555;margin-top:4px;font-size:10px">${err}</div>
      <button onclick="vscode.postMessage({command:'refresh'})"
        style="margin-top:8px;padding:3px 8px;background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:10px">
        ${t.retry}</button>
      <script>const vscode=acquireVsCodeApi();</script></body></html>`;
  }

  private _getWebviewContent(): string {
    const t = T[this._lang];
    const isKo = this._lang === 'ko';
    const threeUri = this._view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'three.png')
    ).toString();
    const dunkUri = this._view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'dunk.png')
    ).toString();
    const now = new Date();
    const dateLabel = isKo
      ? now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
      : now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
    const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const events = this._events;
    const selectedCount = events.filter((e) => this._selectedGames.has(e.id)).length;

    // ── Game cards ──────────────────────────────────────────
    const gameCards = events.map((event) => {
      const comp = event.competitions[0];
      if (!comp) return '';
      const away = comp.competitors.find((c) => c.homeAway === 'away');
      const home = comp.competitors.find((c) => c.homeAway === 'home');
      if (!away || !home) return '';

      const status = comp.status;
      const sName = status.type.name;
      const isLive = sName === 'STATUS_IN_PROGRESS';
      const isFinal = sName === 'STATUS_FINAL';
      const isScheduled = sName === 'STATUS_SCHEDULED';
      const isSelected = this._selectedGames.has(event.id);
      const hasNewPlay = this._newPlayEventIds.has(event.id);

      let statusLine1 = '';
      let statusLine2 = '';
      let cardClass = 'scheduled';

      if (isLive) {
        cardClass = 'live';
        if (status.period > 4) {
          statusLine1 = isKo ? `연장${status.period - 4}` : `OT${status.period - 4}`;
        } else {
          statusLine1 = isKo ? `${status.period}쿼터` : `Q${status.period}`;
        }
        statusLine2 = status.displayClock;
      } else if (isFinal) {
        cardClass = 'final';
        statusLine1 = t.final;
        const d = new Date(event.date);
        statusLine2 = isKo
          ? d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }).replace('. ', '/').replace('. ', '')
          : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
      } else if (isScheduled) {
        cardClass = 'scheduled';
        statusLine1 = t.scheduled;
        const d = new Date(event.date);
        statusLine2 = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      } else {
        cardClass = 'scheduled';
        statusLine1 = status.type.shortDetail;
        statusLine2 = '';
      }

      const awayScore = isScheduled ? '-' : (away.score || '0');
      const homeScore = isScheduled ? '-' : (home.score || '0');
      const venue = comp.venue?.fullName ?? '';

      // ── Play-by-play feed ───────────────────────────────
      let playFeedHtml = '';
      if (isSelected) {
        const plays = this._playMap.get(event.id) ?? [];
        const shouldShowPlays = plays.length > 0 && (isLive || (isFinal && this._isFinalPlayRetained(event.id)));
        if (shouldShowPlays) {
          const rosterMap = this._rosterMap.get(event.id);
          const rows = plays.map((play, idx) => {
            const { emoji, label, labelKo, labelClass, descKo } = classifyPlay(play);
            const player = getPlayerName(play);
            const period = getPlayPeriod(play);
            const clock = getPlayClock(play);
            // Prefer athlete→team lookup from roster (more reliable than play.team.id,
            // which can point to the *fouled* team on free throws / foul plays)
            const teamId = (() => {
              for (const p of (play.participants ?? [])) {
                const aid = String(p.athlete?.id ?? '');
                if (aid && rosterMap?.has(aid)) { return rosterMap.get(aid)!; }
              }
              return String(play.team?.id ?? '');
            })();
            const isHomePlay = teamId === home.team.id;
            const isAwayPlay = teamId === away.team.id;
            let teamLogo = isHomePlay ? home.team.logo
              : isAwayPlay ? away.team.logo : '';
            let teamAbbr = isHomePlay ? home.team.abbreviation
              : isAwayPlay ? away.team.abbreviation : '';
            let teamSide = isHomePlay ? 'home' : isAwayPlay ? 'away' : '';
            // Slide-in animation on the newest row when a new play arrived
            const newClass = (idx === 0 && hasNewPlay) ? ' new-play' : '';

            // Display label & description by language
            const displayLabel = isKo ? labelKo : label;
            let desc: string;
            if (isKo) {
              desc = descKo;
            } else {
              desc = play.text || '';
              if (player && desc.startsWith(player)) {
                desc = desc.slice(player.length).replace(/^[\s·\-]+/, '');
              }
              if (desc.length > 45) { desc = desc.slice(0, 44) + '…'; }
            }
            const displayPlayer = isKo ? getPlayerNameKo(player) : player;

            // Jump ball: show both players, no team attribution
            const isJumpBall = labelClass === 'misc' &&
              ((play.text || '') + ' ' + (play.type?.text || '')).toLowerCase().includes('jump ball');
            if (isJumpBall) { teamLogo = ''; teamAbbr = ''; teamSide = ''; }
            let pBody: string;
            if (isJumpBall) {
              const jbText = play.text || '';
              // Extract "Tip to X" if present (e.g. "... vs. Gafford: Tip to Smith")
              const tipMatch = jbText.match(/[:\-]\s*Tip to\s+(.+)$/i);
              const tipPlayer = tipMatch ? tipMatch[1].trim() : '';
              const mainText = tipMatch ? jbText.slice(0, tipMatch.index).trim() : jbText;
              // ESPN may send "Jump Ball X vs. Y" or just "X vs. Y" (with type.text = "jumpball")
              const vsMatch = mainText.match(/(?:Jump Ball\s+)?(.+?)\s+vs\.?\s+(.+?)$/i);
              const tipLabel = tipPlayer
                ? ` → ${isKo ? getPlayerNameKo(tipPlayer) : tipPlayer}`
                : '';
              if (vsMatch) {
                const p1 = isKo ? getPlayerNameKo(vsMatch[1].trim()) : vsMatch[1].trim();
                const p2 = isKo ? getPlayerNameKo(vsMatch[2].trim()) : vsMatch[2].trim();
                pBody = `<span class="p-player">${p1} vs. ${p2}${tipLabel}</span>
                  <span class="p-desc">${isKo ? '점프볼' : 'Jump Ball'}</span>`;
              } else {
                pBody = `<span class="p-player">${mainText}${tipLabel}</span>
                  <span class="p-desc">${isKo ? '점프볼' : 'Jump Ball'}</span>`;
              }
            } else if (labelClass === 'sub') {
              const { inPlayer, outPlayer } = extractSubPlayers(play);
              const inName  = isKo ? getPlayerNameKo(inPlayer)  : inPlayer;
              const outName = isKo ? getPlayerNameKo(outPlayer) : outPlayer;
              pBody = `
                ${inName  ? `<span class="p-player sub-in">↑ ${inName} IN</span>`  : ''}
                ${outName ? `<span class="p-player sub-out">↓ ${outName} OUT</span>` : ''}`;
            } else {
              pBody = `
                ${displayPlayer ? `<span class="p-player">${displayPlayer}</span>` : ''}
                ${desc ? `<span class="p-desc">${desc}</span>` : ''}`;
            }

            return `<div class="play-row ${teamSide}${newClass}">
              ${teamLogo
                ? `<img class="p-logo" src="${teamLogo}" title="${teamAbbr}" onerror="this.style.display='none'">`
                : `<span class="p-logo-placeholder"></span>`}
              ${emoji === '🤟'
                ? `<img class="p-emoji-img" src="${threeUri}" alt="3PT">`
                : emoji === '💥'
                  ? `<img class="p-emoji-img" src="${dunkUri}" alt="DUNK">`
                  : `<span class="p-emoji">${emoji}</span>`}
              <div class="p-body">
                ${pBody}
              </div>
              <div class="p-meta">
                ${displayLabel ? `<span class="p-label ${labelClass}">${displayLabel}</span>` : ''}
                ${period || clock ? `<span class="p-clock">${period}${clock ? ' ' + clock : ''}</span>` : ''}
              </div>
            </div>`;
          }).join('');
          playFeedHtml = `<div class="play-feed">${rows}</div>`;
        } else if (isLive) {
          playFeedHtml = `<div class="play-feed"><div class="play-empty">${t.fetchingPlays}</div></div>`;
        } else if (isScheduled) {
          const d = new Date(event.date);
          const startTime = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          playFeedHtml = `<div class="play-feed"><div class="play-empty">${t.gameStart(startTime)}<br>${t.autoFeed}</div></div>`;
        } else if (isFinal) {
          playFeedHtml = `<div class="play-feed"><div class="play-empty">${t.gameOver}</div></div>`;
        }
      }

      return `
        <div class="game-card ${cardClass} ${isSelected ? 'selected' : ''}">
          <div class="game-row">
            <button class="star-btn ${isSelected ? 'on' : ''}"
              onclick="toggle('${event.id}')"
              title="${isSelected ? t.removeGame : t.addGame}">${isSelected ? '★' : '☆'}</button>

            <!-- Away: logo + abbr -->
            <div class="team-side">
              <img class="logo" src="${away.team.logo}" onerror="this.style.display='none'">
              <span class="abbr">${away.team.abbreviation}</span>
            </div>

            <!-- Center: badge + scores + time + venue -->
            <div class="match-center">
              <span class="period-badge ${cardClass}">${statusLine1}</span>
              <div class="scores-row">
                <span class="big-score">${awayScore}</span>
                <span class="score-sep">-</span>
                <span class="big-score">${homeScore}</span>
              </div>
              ${statusLine2 ? `<span class="match-time">${statusLine2}</span>` : ''}
              ${venue ? `<span class="match-venue">${venue}</span>` : ''}
            </div>

            <!-- Home: home badge + abbr + logo -->
            <div class="team-side home-side">
              <div class="home-info">
                <span class="home-badge">${t.home}</span>
                <span class="abbr">${home.team.abbreviation}</span>
              </div>
              <img class="logo" src="${home.team.logo}" onerror="this.style.display='none'">
            </div>
          </div>
          ${playFeedHtml}
          ${(() => {
            const isStatsExpanded = this._expandedStats.has(event.id);
            const isStatsLoading  = this._statsLoading.has(event.id);
            const gameStats = this._statsMap.get(event.id);
            const btnLabel = isStatsExpanded ? `▲ ${t.stats}` : `▼ ${t.stats}`;
            let statsPanel = '';
            if (isStatsExpanded) {
              if (isStatsLoading) {
                statsPanel = `<div class="stats-panel"><span class="stats-msg">${t.statsLoading}</span></div>`;
              } else if (!gameStats) {
                statsPanel = `<div class="stats-panel"><span class="stats-msg">${t.statsNone}</span></div>`;
              } else {
                const colHeaders = STAT_COLS.map(c =>
                  `<th class="stat-th">${isKo ? c.ko : c.en}</th>`).join('');
                const renderTeam = (team: TeamStats) => {
                  let lastWasStarter: boolean | null = null;
                  return team.players.map(p => {
                    let divider = '';
                    if (lastWasStarter === true && !p.starter) {
                      divider = `<tr class="stats-divider"><td colspan="${STAT_COLS.length + 1}"></td></tr>`;
                    }
                    lastWasStarter = p.starter;
                    const cells = STAT_COLS.map(c =>
                      `<td class="stat-td">${p.stats[c.key] ?? '-'}</td>`).join('');
                    const displayName = isKo ? getPlayerNameKo(p.name) : p.name;
                    const shortName = displayName.length > 14 ? displayName.slice(0, 13) + '…' : displayName;
                    return divider + `<tr class="stat-row${p.starter ? ' starter' : ''}">
                      <td class="stat-name">${shortName}</td>${cells}</tr>`;
                  }).join('');
                };
                const renderSection = (team: TeamStats) =>
                  `<tr class="stats-team-header">
                    <th class="stat-team-th" colspan="${STAT_COLS.length + 1}">${team.abbr}</th>
                  </tr>
                  <tr class="stats-header-row">
                    <th class="stat-name-th">${isKo ? '선수' : 'Player'}</th>${colHeaders}
                  </tr>
                  ${renderTeam(team)}`;
                statsPanel = `<div class="stats-panel">
                  <div class="stats-scroll">
                    <table class="stats-table">
                      ${renderSection(gameStats.away)}
                      <tr class="stats-spacer"><td colspan="${STAT_COLS.length + 1}"></td></tr>
                      ${renderSection(gameStats.home)}
                    </table>
                  </div>
                </div>`;
              }
            }
            return `<button class="stats-btn" onclick="toggleStats('${event.id}')">${btnLabel}</button>${statsPanel}`;
          })()}
        </div>`;
    }).join('');

    const noGames = events.length === 0
      ? `<div class="no-games">🏀<br>${t.noGames}</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #1a1a1a;
  color: #ddd;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  padding: 4px 5px;
}

/* Header */
.header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 3px 1px 5px; border-bottom: 1px solid #252525; margin-bottom: 5px;
}
.header-left { font-size: 9px; color: #777; }
.refresh-btn {
  background: none; border: none; color: #777;
  cursor: pointer; font-size: 13px; padding: 0; line-height: 1;
}
.refresh-btn:hover { color: #ccc; }
.lang-btn {
  background: none; border: 1px solid #2d2d2d; color: #666;
  cursor: pointer; font-size: 8px; font-weight: 700;
  padding: 1px 4px; border-radius: 3px; line-height: 1.4;
}
.lang-btn:hover { color: #aaa; border-color: #555; }
.lang-btn.active { color: #5b9bd5; border-color: #1e3a5f; background: rgba(30,58,95,0.3); }
.sub-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 5px;
}
.game-count { font-size: 9px; color: #777; }
.watching-hint { font-size: 9px; color: #5b9bd5; }

/* Game card */
.game-card {
  background: #212121; border-radius: 5px; margin-bottom: 4px;
  border-left: 2px solid #2a2a2a; overflow: hidden;
}
.game-card.live    { border-left-color: #555; }
.game-card.live.selected { border-left-color: #f8a019; }
.game-card.final   { border-left-color: #2a2a2a; }
.game-card.scheduled { border-left-color: #1e3a5f; }
.game-card.selected { background: #1d2433; }

/* Row layout */
.game-row {
  display: flex; align-items: center;
  padding: 5px 5px; gap: 4px;
}
.star-btn {
  background: none; border: none; cursor: pointer;
  font-size: 13px; color: #666; padding: 0 1px 0 0; flex-shrink: 0;
  line-height: 1;
}
.star-btn.on { color: #f8a019; }
.star-btn:hover { color: #aaa; }

/* Team sides */
.team-side {
  display: flex; align-items: center; gap: 5px; flex-shrink: 0;
}
.home-side { flex-direction: row-reverse; margin-right: 8px; }
.home-info {
  display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
}
.logo { width: 24px; height: 24px; object-fit: contain; flex-shrink: 0; }
.abbr { font-size: 9px; font-weight: 700; color: #aaa; white-space: nowrap; }
.home-badge {
  font-size: 7px; background: #1e3a5f; color: #5b9bd5;
  padding: 1px 3px; border-radius: 2px; white-space: nowrap;
}

/* Center column: badge → scores → time → venue */
.match-center {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  gap: 1px; min-width: 0;
}
.period-badge {
  font-size: 9px; font-weight: 700;
  padding: 2px 7px; border-radius: 10px; white-space: nowrap;
}
.period-badge.live {
  background: #f8a019; color: #1a1a1a;
  animation: badgePulse 2s ease-in-out infinite;
}
.period-badge.final     { background: #2a2a2a; color: #555; }
.period-badge.scheduled { background: #1e3a5f; color: #5b9bd5; }
@keyframes badgePulse {
  0%,100% { opacity: 1; }
  50%      { opacity: 0.7; }
}
.scores-row {
  display: flex; align-items: center; gap: 5px;
}
.big-score {
  font-size: 22px; font-weight: 800; color: #e0e0e0;
  min-width: 26px; text-align: center;
  font-variant-numeric: tabular-nums; letter-spacing: -1px;
}
.score-sep { font-size: 14px; color: #666; font-weight: 300; }
.match-time  { font-size: 9px; color: #999; text-align: center; white-space: nowrap; }
.match-venue {
  font-size: 9px; color: #777; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90px;
}

/* Play feed */
.play-feed {
  border-top: 1px solid #252525;
  background: #191919;
  padding: 3px 0;
  max-height: 260px;
  overflow-y: auto;
  overflow-x: auto;
}
.play-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px 3px 0;
  border-bottom: 1px solid #1e1e1e;
  border-left: 2px solid transparent;
  min-width: max-content;
}
.play-row:last-child { border-bottom: none; }
.play-row:hover { background: #1f1f1f; }
.play-row.home { border-left-color: #3a6ea5; }
.play-row.away { border-left-color: #6a3a3a; }

/* New play: slide down + brief amber glow */
@keyframes newPlayIn {
  0%   { opacity: 0; transform: translateY(-5px); background: rgba(248,160,25,0.14); }
  50%  { opacity: 1; transform: translateY(0);    background: rgba(248,160,25,0.07); }
  100% {                                           background: transparent; }
}
.play-row.new-play {
  animation: newPlayIn 0.45s ease-out forwards;
}

.p-logo {
  width: 16px; height: 16px; object-fit: contain;
  flex-shrink: 0; margin-left: 4px;
}
.p-logo-placeholder { width: 16px; flex-shrink: 0; margin-left: 4px; }
.p-emoji { font-size: 12px; flex-shrink: 0; width: 16px; text-align: center; }
.p-emoji-img { width: 16px; height: 16px; flex-shrink: 0; object-fit: contain; }
.p-body {
  display: flex; flex-direction: column; flex: 1; gap: 1px; min-width: 0;
  overflow-x: auto;
}
.p-player {
  font-size: 10px; font-weight: 700; color: #ddd;
  white-space: nowrap;
}
.p-desc {
  font-size: 9px; color: #999;
  white-space: nowrap;
}
.p-meta {
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 1px; flex-shrink: 0;
}
.p-label {
  font-size: 8px; font-weight: 700; padding: 1px 4px;
  border-radius: 3px; white-space: nowrap;
}
.p-label.three   { background: rgba(248,160,25,0.15); color: #f8a019; }
.p-label.score   { background: rgba(100,200,100,0.1); color: #7dbf7d; }
.p-label.ft      { background: rgba(100,150,200,0.1); color: #7aabcf; }
.p-label.miss    { background: rgba(200,80,80,0.1);  color: #c07070; }
.p-label.reb     { background: rgba(150,100,200,0.1); color: #b08fcc; }
.p-label.def     { background: rgba(80,160,200,0.1); color: #60a8c8; }
.p-label.to      { background: rgba(200,150,50,0.1); color: #c8a050; }
.p-label.foul    { background: rgba(180,100,180,0.1); color: #c08bc0; }
.p-label.misc    { background: transparent; color: #666; }
.p-label.sub     { background: rgba(80,200,120,0.12); color: #5abf80; }
.sub-in  { color: #5abf80; }
.sub-out { color: #c07070; }
.p-clock { font-size: 8px; color: #777; white-space: nowrap; }
.play-empty {
  padding: 8px 10px; color: #666; font-size: 10px; text-align: center; line-height: 1.7;
}

.no-games { text-align: center; padding: 30px 10px; color: #666; line-height: 2.2; font-size: 11px; }

/* Stats */
.stats-btn {
  display: block; width: 100%; background: none; border: none;
  border-top: 1px solid #252525; color: #777; font-size: 9px;
  cursor: pointer; padding: 4px 8px; text-align: left;
}
.stats-btn:hover { color: #ccc; background: #1f1f1f; }
.stats-panel { border-top: 1px solid #252525; background: #0f0f0f; }
.stats-msg { display: block; padding: 8px; font-size: 9px; color: #444; }
.stats-scroll { overflow-x: auto; overflow-y: auto; max-height: 320px; }
.stats-table {
  border-collapse: collapse; min-width: max-content; width: 100%; font-size: 9px;
}
.stats-team-header th {
  background: #1a1a2e; color: #5b9bd5; font-size: 9px; font-weight: 700;
  padding: 4px 6px; text-align: left; position: sticky; top: 0; z-index: 2;
}
.stats-header-row th {
  background: #141414; color: #666; font-size: 8px; font-weight: 600;
  padding: 3px 5px; white-space: nowrap; position: sticky; top: 17px; z-index: 1;
  border-bottom: 1px solid #252525;
}
.stat-name-th {
  position: sticky !important; left: 0; z-index: 3 !important;
  background: #141414 !important; min-width: 100px;
}
.stat-row td { padding: 3px 5px; border-bottom: 1px solid #1a1a1a; white-space: nowrap; }
.stat-row.starter .stat-name { color: #ddd; }
.stat-row:not(.starter) .stat-name { color: #888; }
.stat-name {
  position: sticky; left: 0; background: #0f0f0f;
  min-width: 100px; max-width: 120px; z-index: 1;
  border-right: 1px solid #252525;
}
.stat-row.starter .stat-name { background: #111; }
.stat-td { color: #aaa; text-align: right; min-width: 32px; }
.stat-row:hover td { background: #1a1a1a; }
.stat-row:hover .stat-name { background: #1a1a1a; }
.stats-divider td { padding: 0; border-top: 1px dashed #252525; }
.stats-spacer td { height: 6px; background: #0a0a0a; }
</style>
</head>
<body>
  <div class="header">
    <span class="header-left">🏀 ${dateLabel} · ${timeLabel}</span>
    <div style="display:flex;align-items:center;gap:5px;">
      <button class="lang-btn ${isKo ? 'active' : ''}" onclick="setLang('ko')">KO</button>
      <span style="color:#333;font-size:9px;">|</span>
      <button class="lang-btn ${!isKo ? 'active' : ''}" onclick="setLang('en')">EN</button>
    </div>
  </div>
  ${events.length > 0 ? `
  <div class="sub-header">
    <span class="game-count">${t.todayGames(events.length)}</span>
    ${selectedCount > 0 ? `<span class="watching-hint">${t.watching(selectedCount)}</span>` : `<span class="watching-hint">${t.selectHint}</span>`}
  </div>` : ''}
  ${gameCards}
  ${noGames}
  <script>
    const vscode = acquireVsCodeApi();
    function toggle(id) { vscode.postMessage({ command: 'toggleGame', eventId: id }); }
    function setLang(lang) { vscode.postMessage({ command: 'setLang', lang }); }
    function toggleStats(id) { vscode.postMessage({ command: 'toggleStats', eventId: id }); }

    // Restore scroll position after re-render
    (function restoreScroll() {
      const prev = vscode.getState() || {};
      if (typeof prev.scrollTop === 'number' && prev.scrollTop > 0) {
        const target = prev.scrollTop;
        // Double-rAF ensures layout is complete before restoring
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.documentElement.scrollTop = target;
            document.body.scrollTop = target;
            // Fallback: if rAF wasn't enough, retry after a short delay
            setTimeout(() => {
              if (document.documentElement.scrollTop < target - 5) {
                document.documentElement.scrollTop = target;
                document.body.scrollTop = target;
              }
            }, 50);
          });
        });
      }
      // Persist scroll position on every scroll event
      document.addEventListener('scroll', () => {
        const st = document.documentElement.scrollTop || document.body.scrollTop;
        vscode.setState({ scrollTop: st });
      }, { passive: true });
    })();

    // Drag-to-scroll for stats tables
    document.addEventListener('mousedown', (e) => {
      const el = e.target.closest('.stats-scroll');
      if (!el) { return; }
      let startX = e.pageX, scrollLeft = el.scrollLeft, dragging = false;
      const onMove = (e) => {
        const dx = e.pageX - startX;
        if (!dragging && Math.abs(dx) < 4) { return; }
        dragging = true;
        el.scrollLeft = scrollLeft - dx;
        e.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragging) { el.style.cursor = 'grab'; }
      };
      el.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('.stats-scroll');
      if (el) { el.style.cursor = 'grab'; }
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new NbaScoreViewProvider(context.extensionUri, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NbaScoreViewProvider.viewType, provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('nbaLiveScore.refresh', () => provider.refresh())
  );
}

export function deactivate() {}
