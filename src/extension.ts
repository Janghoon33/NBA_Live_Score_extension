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
  participants?: Array<{ athlete?: { displayName?: string; shortName?: string } }>;
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

async function fetchPlays(eventId: string): Promise<EspnPlay[]> {
  try {
    const json: any = await fetchData(ESPN_SUMMARY_BASE + eventId);
    const arr: any[] = Array.isArray(json.plays)
      ? json.plays
      : (json.plays?.items ?? []);
    return arr.filter((p: any) => p.text?.trim()).slice(-15).reverse();
  } catch {
    return [];
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
  const t = (play.text || '').toLowerCase();
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
  if (t.includes('misses') || t.includes('miss'))
    return { emoji: '❌', label: 'MISS',      labelKo: '실패',      labelClass: 'miss',  descKo: '슛 실패' };
  // Rebounds
  if (t.includes('offensive rebound'))
    return { emoji: '💪', label: 'OFF REB',   labelKo: '공격리바',  labelClass: 'reb',   descKo: '공격 리바운드' };
  if (t.includes('rebound'))
    return { emoji: '🫳', label: 'REB',       labelKo: '리바운드',  labelClass: 'reb',   descKo: '수비 리바운드' };
  // Defense
  if (t.includes('steal'))
    return { emoji: '✊', label: 'STEAL',     labelKo: '스틸',      labelClass: 'def',   descKo: '볼 스틸' };
  if (t.includes('block'))
    return { emoji: '🚫', label: 'BLOCK',     labelKo: '블록',      labelClass: 'def',   descKo: '블록슛' };
  // Turnovers (split by subtype for better Korean)
  if (t.includes('bad pass'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '패스 실수' };
  if (t.includes('lost ball'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '볼 분실' };
  if (t.includes('turnover'))
    return { emoji: '🔄', label: 'TURNOVER',  labelKo: '턴오버',    labelClass: 'to',    descKo: '턴오버' };
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
  if (t.includes('jump ball'))
    return { emoji: '⚡', label: 'JUMP BALL', labelKo: '점프볼',    labelClass: 'misc',  descKo: '점프볼' };
  if (t.includes('violation'))
    return { emoji: '🚷', label: 'VIOLATION', labelKo: '바이얼레이션', labelClass: 'misc', descKo: '룰 위반' };

  return { emoji: '▸', label: '', labelKo: '', labelClass: 'misc', descKo: '' };
}

function getPlayPeriod(play: EspnPlay): string {
  const p = typeof play.period === 'object' ? play.period?.number : play.period;
  if (!p) return '';
  return p > 4 ? `OT${p - 4}` : `Q${p}`;
}

function getPlayClock(play: EspnPlay): string {
  return play.clock?.displayValue ?? '';
}

function getPlayerName(play: EspnPlay): string {
  return (
    play.participants?.[0]?.athlete?.displayName ||
    play.participants?.[0]?.athlete?.shortName ||
    play.athletesInvolved?.[0]?.displayName ||
    ''
  );
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
  },
} as const;

// ── Provider ──────────────────────────────────────────────────
export class NbaScoreViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nbaScoreView';
  private _view?: vscode.WebviewView;
  private _scoreTimer?: NodeJS.Timeout;
  private _playTimer?: NodeJS.Timeout;
  private _selectedGames: Set<string>;
  private _events: EspnEvent[] = [];
  private _playMap = new Map<string, EspnPlay[]>();
  private _lastPlayText = new Map<string, string>(); // eventId -> most recent play text
  private _newPlayEventIds = new Set<string>();       // games with a freshly arrived play
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
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh') { this._refresh(); }
      if (msg.command === 'toggleGame') { await this._toggleGame(msg.eventId); }
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

  private _liveSelectedEvents(): EspnEvent[] {
    return this._events.filter(
      (e) =>
        this._selectedGames.has(e.id) &&
        e.competitions[0]?.status?.type?.name === 'STATUS_IN_PROGRESS'
    );
  }

  // ── Toggle ────────────────────────────────────────────────────
  private async _toggleGame(eventId: string) {
    if (this._selectedGames.has(eventId)) {
      // Remove: update state and render immediately — no async before render
      this._selectedGames.delete(eventId);
      this._playMap.delete(eventId);
      this._lastPlayText.delete(eventId);
      this._render();
    } else {
      // Add: show star on instantly, then load plays
      this._selectedGames.add(eventId);
      this._render();
      const ev = this._events.find((e) => e.id === eventId);
      if (ev?.competitions[0]?.status?.type?.name === 'STATUS_IN_PROGRESS') {
        const plays = await fetchPlays(eventId);
        this._playMap.set(eventId, plays);
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
        if (!validIds.has(id)) { this._selectedGames.delete(id); }
      }

      const liveSelected = this._liveSelectedEvents();
      if (liveSelected.length > 0) {
        const plays = await Promise.all(liveSelected.map((e) => fetchPlays(e.id)));
        liveSelected.forEach((e, i) => {
          this._playMap.set(e.id, plays[i]);
          this._lastPlayText.set(e.id, plays[i][0]?.text ?? '');
        });
      }

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
        if (!validIds.has(id)) { this._selectedGames.delete(id); }
      }

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

      const plays = await Promise.all(liveSelected.map((e) => fetchPlays(e.id)));

      let changed = false;
      this._newPlayEventIds.clear();
      liveSelected.forEach((e, i) => {
        const newPlays = plays[i];
        const newFirst = newPlays[0]?.text ?? '';
        const oldFirst = this._lastPlayText.get(e.id) ?? '';
        if (newFirst !== oldFirst) {
          changed = true;
          this._newPlayEventIds.add(e.id);
          this._lastPlayText.set(e.id, newFirst);
          this._playMap.set(e.id, newPlays);
        }
      });

      if (changed) { this._render(); }
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
        statusLine1 = `Q${status.period}`;
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
        if (isLive && plays.length > 0) {
          const rows = plays.map((play, idx) => {
            const { emoji, label, labelKo, labelClass, descKo } = classifyPlay(play);
            const player = getPlayerName(play);
            const period = getPlayPeriod(play);
            const clock = getPlayClock(play);
            const teamId = String(play.team?.id ?? '');
            const isHomePlay = teamId === home.team.id;
            const isAwayPlay = teamId === away.team.id;
            const teamLogo = isHomePlay ? home.team.logo
              : isAwayPlay ? away.team.logo : '';
            const teamAbbr = isHomePlay ? home.team.abbreviation
              : isAwayPlay ? away.team.abbreviation : '';
            const teamSide = isHomePlay ? 'home' : isAwayPlay ? 'away' : '';
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

            return `<div class="play-row ${teamSide}${newClass}">
              ${teamLogo
                ? `<img class="p-logo" src="${teamLogo}" title="${teamAbbr}" onerror="this.style.display='none'">`
                : `<span class="p-logo-placeholder"></span>`}
              <span class="p-emoji">${emoji}</span>
              <div class="p-body">
                ${displayPlayer ? `<span class="p-player">${displayPlayer}</span>` : ''}
                ${desc ? `<span class="p-desc">${desc}</span>` : ''}
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

            <!-- Away -->
            <div class="team away">
              <img class="logo" src="${away.team.logo}" onerror="this.style.display='none'">
              <span class="abbr">${away.team.abbreviation}</span>
              <span class="big-score">${awayScore}</span>
            </div>

            <!-- Center -->
            <div class="center-panel">
              ${isLive ? '<span class="live-dot"></span>' : ''}
              <span class="s1 ${cardClass}">${statusLine1}</span>
              ${statusLine2 ? `<span class="s2">${statusLine2}</span>` : ''}
              ${venue ? `<span class="venue">${venue}</span>` : ''}
            </div>

            <!-- Home -->
            <div class="team home">
              <span class="big-score">${homeScore}</span>
              <div class="home-label-wrap">
                <span class="home-badge">${t.home}</span>
                <span class="abbr">${home.team.abbreviation}</span>
              </div>
              <img class="logo" src="${home.team.logo}" onerror="this.style.display='none'">
            </div>
          </div>
          ${playFeedHtml}
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
  color: #ccc;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  padding: 4px 5px;
}

/* Header */
.header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 3px 1px 5px; border-bottom: 1px solid #252525; margin-bottom: 5px;
}
.header-left { font-size: 9px; color: #555; }
.refresh-btn {
  background: none; border: none; color: #555;
  cursor: pointer; font-size: 13px; padding: 0; line-height: 1;
}
.refresh-btn:hover { color: #aaa; }
.lang-btn {
  background: none; border: 1px solid #2d2d2d; color: #444;
  cursor: pointer; font-size: 8px; font-weight: 700;
  padding: 1px 4px; border-radius: 3px; line-height: 1.4;
}
.lang-btn:hover { color: #aaa; border-color: #555; }
.lang-btn.active { color: #5b9bd5; border-color: #1e3a5f; background: rgba(30,58,95,0.3); }
.sub-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 5px;
}
.game-count { font-size: 9px; color: #444; }
.watching-hint { font-size: 9px; color: #3a6ea5; }

/* Game card */
.game-card {
  background: #212121; border-radius: 5px; margin-bottom: 4px;
  border-left: 2px solid #2a2a2a; overflow: hidden;
}
.game-card.live    { border-left-color: #f8a019; }
.game-card.final   { border-left-color: #2a2a2a; }
.game-card.scheduled { border-left-color: #1e3a5f; }
.game-card.selected { background: #1d2433; }

/* Row layout */
.game-row {
  display: flex; align-items: center;
  padding: 6px 5px; gap: 3px;
}
.star-btn {
  background: none; border: none; cursor: pointer;
  font-size: 13px; color: #444; padding: 0 3px 0 0; flex-shrink: 0;
  line-height: 1;
}
.star-btn.on { color: #f8a019; }
.star-btn:hover { color: #aaa; }

/* Team sides */
.team { display: flex; align-items: center; flex: 1; gap: 4px; min-width: 0; }
.team.home { flex-direction: row-reverse; }
.logo { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
.abbr { font-size: 10px; font-weight: 700; color: #888; white-space: nowrap; }
.big-score {
  font-size: 18px; font-weight: 800; color: #ccc;
  min-width: 26px; text-align: center; flex-shrink: 0;
  font-variant-numeric: tabular-nums; letter-spacing: -1px;
}
.home-label-wrap {
  display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
}
.home-badge {
  font-size: 7px; background: #1e3a5f; color: #5b9bd5;
  padding: 1px 3px; border-radius: 2px;
}

/* Center panel */
.center-panel {
  display: flex; flex-direction: column; align-items: center;
  min-width: 60px; max-width: 68px; flex-shrink: 0; gap: 1px;
}
.live-dot {
  width: 5px; height: 5px; background: #f8a019;
  border-radius: 50%; animation: pulse 1.2s ease-in-out infinite; margin-bottom: 1px;
}
@keyframes pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%      { opacity:0.3; transform:scale(0.6); }
}
.s1 { font-size: 10px; font-weight: 700; text-align: center; }
.s1.live      { color: #f8a019; }
.s1.final     { color: #666; }
.s1.scheduled { color: #5b9bd5; }
.s2 { font-size: 9px; color: #555; text-align: center; white-space: nowrap; }
.venue {
  font-size: 7px; color: #333; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 66px;
}

/* Play feed */
.play-feed {
  border-top: 1px solid #252525;
  background: #191919;
  padding: 3px 0;
  max-height: 260px;
  overflow-y: auto;
}
.play-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px 3px 0;
  border-bottom: 1px solid #1e1e1e;
  border-left: 2px solid transparent;
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
.p-body {
  display: flex; flex-direction: column; flex: 1; gap: 1px; min-width: 0;
}
.p-player {
  font-size: 10px; font-weight: 700; color: #bbb;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.p-desc {
  font-size: 9px; color: #666;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
.p-label.misc    { background: transparent; color: #444; }
.p-clock { font-size: 8px; color: #333; white-space: nowrap; }
.play-empty {
  padding: 8px 10px; color: #444; font-size: 10px; text-align: center; line-height: 1.7;
}

.no-games { text-align: center; padding: 30px 10px; color: #444; line-height: 2.2; font-size: 11px; }
</style>
</head>
<body>
  <div class="header">
    <span class="header-left">🏀 ${dateLabel} · ${timeLabel}</span>
    <div style="display:flex;align-items:center;gap:5px;">
      <button class="lang-btn ${isKo ? 'active' : ''}" onclick="setLang('ko')">KO</button>
      <span style="color:#333;font-size:9px;">|</span>
      <button class="lang-btn ${!isKo ? 'active' : ''}" onclick="setLang('en')">EN</button>
      <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})" title="${t.refresh}">↻</button>
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
