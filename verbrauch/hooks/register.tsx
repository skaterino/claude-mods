import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  Register,
  RenderChildren,
  SessionRateLimit,
  SessionUsage,
  TurnUsage,
} from 'claude-code'

import type { AgentRow, Auto, Background, Limit, Pickup, ShellRow, Snapshot, Warned } from '../types'

// Ab hier gilt der Kontext als gross: jeder API-Call liest ihn komplett neu.
const WARN = 250_000
const ALARM = 400_000
// Ab so viel Prozent eines Limit-Fensters kommt eine Meldung.
const LIMIT_LEVELS = [95, 80]
const TZ = 'Europe/Zurich'
const EVERY_MS = 15_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Im Abo läuft der Prompt-Cache eine Stunde nach dem letzten Call ab. Danach schreibt der
// nächste Prompt den ganzen Kontext neu, je nach Modell 20- bis 80-mal so teuer wie das Lesen
// aus dem warmen Cache (COLD_FACTORS).
const COLD_MS = HOUR
// Ab so viel Kontext hält die Cache-Sperre einen Prompt einmal an.
const HOLD_FROM = 150_000
// Ab so viel Kontext zeigt die Statuszeile den Cache.
const COLD_SHOWN_FROM = 50_000
// So lange bleibt das Ende des letzten Turns einer Session im Store.
const KEEP_MS = 30 * DAY
// Statuszeile: Zellen je Balken.
const CELLS = 8
// Pane: Breite der Beschriftungsspalte und Skala des Kontextbalkens.
const PANE = 'verbrauch'
const LABEL_W = 13
const CONTEXT_SCALE = 500_000
// Prognose erst, wenn so viel vom Fenster vorbei ist: davor sagt das Tempo nichts.
const PACE_FROM = 0.1
// Zwei Messungen gehören zum selben Fenster, wenn ihre Resets so nah beieinander liegen.
const SAME_WINDOW_MS = 30 * MIN
// Ab diesem Alter zeigt die Anzeige, wie alt eine Limit-Messung ist.
const STALE_MS = 5 * MIN
// So lange gilt der erste Druck auf „Sichern & neu starten“; bestätigt wird mit einem eigenen Knopf, frühestens
// nach CONFIRM_MIN_MS, damit kein doppelter Druck (Enter, Klick) beides auf einmal auslöst.
const CONFIRM_MS = 5_000
const CONFIRM_MIN_MS = 700
// Hintergrund: so lange bleibt ein beendeter Agent oder eine Shell im Pane stehen.
const BG_SHOWN_MS = 30 * MIN
// Höchstens so viele Zeilen im Pane, und so viele Agenten merkt sich der Mod je Session.
const BG_ROWS = 8
const BG_KEEP = 300
// Ein Loop ohne Listeneintrag (Workflow-Agent oder interner Fork der Engine) heisst „aktiv“, solange sein
// letzter Aufruf so jung ist. Er zählt nur bei den Kosten: ein Fork fürs Komprimieren ist keine Arbeit,
// auf die die Session wartet, und ein laufender Workflow steht ohnehin als Task in der Liste.
const UNLISTED_ACTIVE_MS = 2 * MIN
const BG_CELLS = 10
// Auto-Neustart: Standardwerte, was erlaubt ist, Schritt der −/+-Knöpfe, Mindestabstand und Countdown.
const AUTO_GRENZE = 400_000
const AUTO_MAX = 3
const GRENZE_MIN = 50_000
const GRENZE_MAX = 900_000
const GRENZE_STEP = 50_000
const MAX_MIN = 1
const MAX_MAX = 20
const AUTO_GAP_MS = 10 * MIN
const COUNTDOWN_S = 30
// So lange nach dem Turn-Ende prüft der Auslöser: classic.Stop (Crons, Hintergrund) kommt laut Messung ~130 ms vor
// turn.complete, so ist es auch bei anderer Reihenfolge da.
const TRIGGER_DELAY_MS = 500
// So lange nach fire gilt ein /clear als der eigene Auto-Neustart (Kette bleibt) und ein Abbruch geht an den
// sessions-Mod. Grosszügig, denn ein langer Sicherungs-Turn darf die Kettenbremse nicht aushebeln.
const FIRED_VALID_MS = 30 * MIN

const warned = atom({ plugin: 'verbrauch', key: 'warned' } as const, { context: 0, limits: {} } as Warned)
// Ende des Turns, nach dem schon einmal angehalten wurde: das zweite Enter geht durch.
const held = atom({ plugin: 'verbrauch', key: 'held' } as const, 0)
const confirm = atom({ plugin: 'verbrauch', key: 'confirm' } as const, 0)
const snap = atom({ plugin: 'verbrauch', key: 'snap' } as const, {
  at: 0,
  limits: [],
  window: 0,
  startedAt: 0,
  lastTurn: 0,
  running: false,
} as Snapshot)
const bg = atom({ plugin: 'verbrauch', key: 'bg' } as const, {
  agents: {},
  shells: {},
  main: { calls: 0, usd: 0, unpriced: false },
} as Background)
// Nur Anzeige: Sekunden bis zum Auto-Neustart. Der Schalter selbst liegt im Store (Atome leert ein /clear).
const countdown = atom({ plugin: 'verbrauch', key: 'countdown' } as const, 0)

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7T', spend_limit: 'Limit' }
const TITLE: Record<string, string> = { five_hour: '5 Stunden', seven_day: '7 Tage', spend_limit: 'Ausgaben' }
const SPAN: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const DAY_NAME: Record<string, string> = { Sun: 'So', Mon: 'Mo', Tue: 'Di', Wed: 'Mi', Thu: 'Do', Fri: 'Fr', Sat: 'Sa' }
// Farbzonen der Balken, als Theme-Farben: grün, gelb, rot.
const LIMIT_ZONES: [number, string][] = [[60, 'success'], [80, 'warning'], [Infinity, 'error']]
const CONTEXT_ZONES: [number, string][] = [[WARN, 'success'], [ALARM, 'warning'], [Infinity, 'error']]
// Preise in USD je Million Tokens: Input, Output, Lesen aus dem Cache (Anthropic-Preisliste laut
// claude-api-Skill, Stand 2026-10-06, geprüft 2026-10-14). Schreiben in den Cache kostet 2× Input:
// Claude Code nutzt im Abo den 1-h-Cache. Fast Mode (2×) ist an der Antwort nicht zu erkennen.
type Price = { input: number; output: number; read: number }
const PRICES: Record<string, Price> = {
  'fable-5-1': { input: 10, output: 50, read: 0.25 },
  'mythos-5-1': { input: 10, output: 50, read: 0.25 },
  'fable-5': { input: 10, output: 50, read: 1 },
  'mythos-5': { input: 10, output: 50, read: 1 },
  'opus-5-5': { input: 4, output: 20, read: 0.2 },
  'opus-5': { input: 5, output: 25, read: 0.5 },
  'opus-4-8': { input: 5, output: 25, read: 0.5 },
  'opus-4-7': { input: 5, output: 25, read: 0.5 },
  'opus-4-6': { input: 5, output: 25, read: 0.5 },
  'sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'sonnet-5': { input: 2, output: 10, read: 0.2 },
  'sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  // Haiku 5.5 liest den Cache zu 0,1× des jeweiligen Input-Preises.
  'haiku-5-5': { input: 0.1, output: 0.5, read: 0.01 },
  'haiku-4-5': { input: 1, output: 5, read: 0.1 },
}
// Haiku 5.5 kostet ab so viel Prompt das Fünffache.
const HAIKU_LONG_FROM = 100_000
const CACHE_WRITE = 2

// "claude-opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-4-6" → "opus-5-5", "sonnet-4-6".
// Die Nebenversion hat höchstens zwei Ziffern, damit ein Datum dahinter nicht mitzählt.
const modelKey = (model: string): string | undefined => {
  const hit = /claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2}(?:-\d{1,2}(?!\d))?)/i.exec(model)
  return hit ? `${hit[1]?.toLowerCase()}-${hit[2]}` : undefined
}

const priceOf = (model: string): Price | undefined => {
  const key = modelKey(model)
  return key === undefined ? undefined : PRICES[key]
}

// API-Gegenwert eines Aufrufs; undefined, wenn das Modell keinen Preis hat.
const costOf = (u: TurnUsage): number | undefined => {
  let p = priceOf(u.model)
  if (!p) return undefined
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (modelKey(u.model) === 'haiku-5-5' && prompt > HAIKU_LONG_FROM) p = { input: 0.5, output: 2.5, read: 0.05 }
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * CACHE_WRITE +
      u.cache_read_input_tokens * p.read +
      u.output_tokens * p.output) /
    1e6
  )
}

// Kalt gegen warm: Neu schreiben in den 1-h-Cache gegen Lesen aus dem Cache. 20 bei 0,1×,
// 40 bei Opus 5.5 (0,05×), 80 bei Fable und Mythos 5.1 (0,025×). $.session.model() nennt die
// volle ID, auch hinter „opus“, samt „[1m]“; ohne Preis gilt der übliche Faktor.
const coldFactor = (model: string): number => {
  const p = priceOf(model)
  return p ? Math.round((p.input * CACHE_WRITE) / p.read) : 20
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

// Restzeit bis zum Reset: "in 1h12", "in 5T 18h".
const fmtLeft = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / MIN))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  return d ? `in ${d}T ${h}h` : h ? `in ${h}h${String(m).padStart(2, '0')}` : `in ${m}m`
}

// Wie lange der Cache schon ruht: "75 Min.", "12 h", "3 Tagen".
const fmtIdle = (ms: number): string => {
  const min = Math.round(ms / MIN)
  if (min < 120) return `${min} Min.`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} Tagen`
}

// Dasselbe knapp für die Statuszeile: "61′", "12h", "3T".
const fmtIdleShort = (ms: number): string => {
  const min = Math.round(ms / MIN)
  if (min < 120) return `${min}′`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}T`
}

// Zeitpunkt als Ortszeit: am selben Tag "18:30", sonst "Mo 09:00".
const fmtWhen = (at: number, now: number): string => {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      weekday: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    const parts = (t: number): Record<string, string> =>
      Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]))
    const r = parts(at)
    const n = parts(now)
    const time = `${r.hour}:${r.minute}`
    return r.day === n.day && Math.abs(at - now) < DAY ? time : `${DAY_NAME[r.weekday ?? ''] ?? r.weekday} ${time}`
  } catch {
    // Laufzeit ohne Zeitzonen: dann wenigstens die Restzeit.
    return fmtLeft(at - now)
  }
}

const parseReset = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const at = Date.parse(iso)
  return Number.isNaN(at) ? undefined : at
}

const fmtReset = (iso: string | undefined, now: number): string => {
  const at = parseReset(iso)
  return at === undefined ? '' : fmtWhen(at, now)
}

// Statuszeile: "▰▰▰▱▱▱▱▱", voll bei 1.
const cells = (frac: number): string => {
  const n = Math.max(0, Math.min(CELLS, Math.round(frac * CELLS)))
  return '▰'.repeat(n) + '▱'.repeat(CELLS - n)
}

// Alter einer Limit-Messung, sobald es sich zu zeigen lohnt; sonst undefined.
const ageOf = (l: Limit, now: number): number | undefined =>
  l.at !== undefined && now - l.at >= STALE_MS ? now - l.at : undefined

type Cache = { state: 'running' } | { state: 'warm'; leftMs: number } | { state: 'cold'; idleMs: number }

const cacheOf = (s: Snapshot): Cache | undefined => {
  if (s.running) return { state: 'running' }
  if (!s.lastTurn) return undefined
  const idle = s.at - s.lastTurn
  return idle < COLD_MS ? { state: 'warm', leftMs: COLD_MS - idle } : { state: 'cold', idleMs: idle }
}

const ENDED = new Set(['completed', 'failed', 'killed', 'gone'])

// Arbeitet der Agent noch, wartet die Session also auf ihn? Ein Teammate, das auf eine Nachricht
// wartet (`idle`), zählt nicht, ein Loop ohne Listeneintrag auch nicht (UNLISTED_ACTIVE_MS).
const isAgentActive = (a: AgentRow): boolean => a.status !== 'unlisted' && a.endedAt === undefined && a.status !== 'idle'

const isRecentUnlisted = (a: AgentRow, now: number): boolean =>
  a.status === 'unlisted' && a.lastCallAt > 0 && now - a.lastCallAt < UNLISTED_ACTIVE_MS

// Ende eines Agenten für Laufzeit und Aufräumen; undefined solange er läuft.
const agentEnd = (a: AgentRow, now: number): number | undefined =>
  a.status === 'unlisted' ? (isRecentUnlisted(a, now) ? undefined : a.lastCallAt || a.startedAt) : a.endedAt

const newAgent = (id: string, now: number): AgentRow => ({
  id,
  description: '',
  type: '',
  status: 'unlisted',
  startedAt: now,
  lastCallAt: 0,
  calls: 0,
  usd: 0,
  unpriced: false,
  outputTokens: 0,
})

// Zählt einen API-Aufruf zum Haupt-Loop oder zum Agenten, in dessen Loop er lief.
const withStep = (b: Background, agentId: string | undefined, u: TurnUsage, now: number): Background => {
  const usd = costOf(u)
  if (agentId === undefined) {
    return {
      ...b,
      main: { calls: b.main.calls + 1, usd: b.main.usd + (usd ?? 0), unpriced: b.main.unpriced || usd === undefined },
    }
  }
  const had = b.agents[agentId] ?? newAgent(agentId, now)
  return {
    ...b,
    agents: {
      ...b.agents,
      [agentId]: {
        ...had,
        calls: had.calls + 1,
        usd: had.usd + (usd ?? 0),
        unpriced: had.unpriced || usd === undefined,
        outputTokens: had.outputTokens + u.output_tokens,
        lastCallAt: now,
        model: u.model,
      },
    },
  }
}

// Übernimmt Beschreibung, Typ und Status aus $.agent.list(). Wer aus der Liste fällt, ohne dass ein
// Ende zu sehen war, gilt ab jetzt als beendet. Über BG_KEEP fallen die ältesten beendeten heraus.
const withList = (b: Background, list: AgentInfo[], now: number): Background => {
  const agents = { ...b.agents }
  const listed = new Set<string>()
  for (const info of list) {
    listed.add(info.id)
    const had = agents[info.id] ?? newAgent(info.id, now)
    const isEnded = ENDED.has(info.status)
    agents[info.id] = {
      ...had,
      description: info.description,
      type: info.type,
      status: info.status,
      endedAt: isEnded ? (had.endedAt ?? now) : undefined,
    }
  }
  for (const [id, a] of Object.entries(agents)) {
    if (!listed.has(id) && a.status !== 'unlisted' && a.endedAt === undefined) {
      agents[id] = { ...a, status: 'gone', endedAt: now }
    }
  }
  const ids = Object.keys(agents)
  if (ids.length > BG_KEEP) {
    const old = ids
      .filter(id => agentEnd(agents[id] as AgentRow, now) !== undefined)
      .sort((x, y) => (agentEnd(agents[x] as AgentRow, now) ?? 0) - (agentEnd(agents[y] as AgentRow, now) ?? 0))
    let prunedUsd = b.prunedUsd ?? 0
    for (const id of old.slice(0, ids.length - BG_KEEP)) {
      prunedUsd += agents[id]?.usd ?? 0
      delete agents[id]
    }
    return { ...b, agents, prunedUsd }
  }
  return { ...b, agents }
}

type TaskSummary = { id: string; type: string; description: string; command?: string }

// Die Liste der Engine beim Turn-Ende ist der Massstab: was dort fehlt, ist fertig.
// Agenten führt $.agent.list(), hier zählen nur Shells, Monitore, Workflows.
const withTasks = (b: Background, tasks: readonly TaskSummary[], now: number): Background => {
  const shells = { ...b.shells }
  const live = new Set<string>()
  for (const t of tasks) {
    if (/agent/i.test(t.type)) continue
    live.add(t.id)
    const had = shells[t.id]
    shells[t.id] = had
      ? { ...had, endedAt: undefined }
      : { id: t.id, kind: t.type, description: t.description || t.command || t.type, startedAt: now }
  }
  for (const [id, s] of Object.entries(shells)) {
    if (!live.has(id) && s.endedAt === undefined) shells[id] = { ...s, endedAt: now }
  }
  for (const [id, s] of Object.entries(shells)) {
    if (s.endedAt !== undefined && now - s.endedAt > BG_SHOWN_MS) delete shells[id]
  }
  return { ...b, shells }
}

// Die Benachrichtigung der Engine, dass eine Hintergrund-Arbeit endete: so sieht man das Ende schon vor dem
// nächsten Turn-Ende. Form wie sie ankommt: <task-notification><task-id>…</task-id>…<status>completed</status>.
const NOTIFIED = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
const LIVE_STATUS = new Set(['running', 'pending'])

const withNotified = (b: Background, text: string, now: number): Background => {
  let shells = b.shells
  for (const [, id = '', status = ''] of text.matchAll(NOTIFIED)) {
    const s = shells[id.trim()]
    if (s && s.endedAt === undefined && !LIVE_STATUS.has(status.trim())) {
      shells = { ...shells, [s.id]: { ...s, endedAt: now } }
    }
  }
  return shells === b.shells ? b : { ...b, shells }
}

const withShell = (b: Background, s: ShellRow): Background =>
  b.shells[s.id] ? b : { ...b, shells: { ...b.shells, [s.id]: s } }

type Busy = { agents: AgentRow[]; shells: ShellRow[]; usd: number }

const busyOf = (b: Background, now: number): Busy => {
  const agents = Object.values(b.agents).filter(isAgentActive)
  const shells = Object.values(b.shells).filter(s => s.endedAt === undefined)
  return { agents, shells, usd: agents.reduce((sum, a) => sum + a.usd, 0) }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// "2 Agenten, 1 Shell": Shells beim Namen, alles andere (Monitor, Workflow) als Task.
const busyText = (busy: Busy, joiner: string): string => {
  const shells = busy.shells.filter(s => s.kind === 'shell').length
  const tasks = busy.shells.length - shells
  return [
    busy.agents.length ? plural(busy.agents.length, 'Agent', 'Agenten') : '',
    shells ? plural(shells, 'Shell', 'Shells') : '',
    tasks ? plural(tasks, 'Task', 'Tasks') : '',
  ]
    .filter(Boolean)
    .join(joiner)
}

const fmtUsd = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

// Laufzeit: "42″", "4′12", "1h05".
const fmtRun = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}″`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}′${String(sec % 60).padStart(2, '0')}`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

const statusLine = (s: Snapshot, b: Background): string => {
  const parts = s.limits
    .filter(l => LABEL[l.kind])
    .map(l => {
      const reset = fmtReset(l.resetsAt, s.at)
      return `${LABEL[l.kind]} ${cells(l.percent / 100)} ${Math.round(l.percent)}%${reset ? ` ↻${reset}` : ''}`
    })
  // Alter der Limits einmal hinter den Balken, nach der ältesten Messung.
  const ages = s.limits.filter(l => LABEL[l.kind]).flatMap(l => ageOf(l, s.at) ?? [])
  if (parts.length && ages.length) parts[parts.length - 1] += ` (vor ${fmtIdleShort(Math.max(...ages))})`
  const tokens = s.tokens
  if (tokens === undefined) {
    parts.push('Ctx –')
  } else {
    const flag = tokens >= ALARM ? ' ⚠ wechseln' : tokens >= WARN ? ' ⚠' : ''
    parts.push(`Ctx ${cells(tokens / ALARM)} ${fmtTokens(tokens)}${flag}`)
  }
  const cache = cacheOf(s)
  if (cache && (cache.state === 'running' || (tokens ?? 0) >= COLD_SHOWN_FROM)) {
    parts.push(
      cache.state === 'running'
        ? '● aktiv'
        : cache.state === 'warm'
          ? `● warm ${Math.ceil(cache.leftMs / MIN)}′`
          : `❄ kalt ${fmtIdleShort(cache.idleMs)}`,
    )
  }
  // Nur solange im Hintergrund etwas arbeitet.
  const busy = busyOf(b, s.at)
  if (busy.agents.length || busy.shells.length) {
    parts.push(`⏳ ${busyText(busy, ' ')}${busy.agents.length ? ` ${fmtUsd(busy.usd)}` : ''}`)
  }
  // Nur solange der Auto-Neustart an ist.
  if (s.auto?.an) parts.push(autoPart(s.auto))
  return parts.join(' │ ')
}

// "🔁 auto", in einer Kette "🔁 auto 2/5", an der Bremse "🔁 auto 5/5 – wartet".
const autoPart = (a: Auto): string =>
  a.kette >= a.max ? `🔁 auto ${a.kette}/${a.max} – wartet` : a.kette > 0 ? `🔁 auto ${a.kette}/${a.max}` : '🔁 auto'

// Wohin das Fenster beim jetzigen Tempo bis zum Reset kommt.
type Pace =
  | { kind: 'early' }
  | { kind: 'past' }
  | { kind: 'full' }
  | { kind: 'projected'; percent: number; hitAt?: number }

const paceOf = (l: Limit, now: number): Pace | undefined => {
  const span = SPAN[l.kind]
  const reset = parseReset(l.resetsAt)
  if (!span || reset === undefined) return undefined
  if (now >= reset) return { kind: 'past' }
  if (l.percent >= 100) return { kind: 'full' }
  const start = reset - span
  const elapsed = now - start
  if (elapsed < span * PACE_FROM || l.percent <= 0) return { kind: 'early' }
  const percent = (l.percent * span) / elapsed
  return percent >= 100 ? { kind: 'projected', percent, hitAt: start + (elapsed * 100) / l.percent } : { kind: 'projected', percent }
}

const zoneColor = (value: number, zones: [number, string][]): string =>
  zones.find(([to]) => value < to)?.[1] ?? 'error'

type Segment = { text: string; color: string; isEmpty: boolean }

// Balken in Farbzonen: gefüllt kräftig, der Rest gedämpft, so sieht man die Schwellen auch leer.
const gauge = (value: number, max: number, zones: [number, string][], width: number): Segment[] => {
  const out: Segment[] = []
  for (let i = 0; i < width; i++) {
    const mid = ((i + 0.5) / width) * max
    const color = zoneColor(mid, zones)
    const isEmpty = value < mid
    const ch = isEmpty ? '░' : '█'
    const last = out[out.length - 1]
    if (last && last.color === color && last.isEmpty === isEmpty) last.text += ch
    else out.push({ text: ch, color, isEmpty })
  }
  return out
}

// Modulzustand: ein Reload setzt ihn zurück, session.start läuft dann neu.
let active = false
let busy = false
let again = false
let shown: string | undefined
// Wann diese Session zuletzt Limits von der API bekam (ms); 0 noch nie.
let measuredAt = 0
// Woran refresh eine neue API-Antwort erkennt: Kosten und Limits beim letzten Lesen.
let seenUsd: number | undefined
let seenLimits: string | undefined
let isBased = false
// Laufende Turns: solange einer läuft, ist der Cache in Gebrauch.
const turns = new Set<string>()
// Auto-Neustart: die ID vor dem letzten /clear, bis der Schalter umgezogen ist ('' nichts umzuziehen); was das
// letzte classic.Stop an Crons und Hintergrund-Arbeit nannte (-1 unbekannt, undefined seit dem Turn-Beginn
// keines); ob ein Prompt von Mike hinter dem laufenden Turn wartet; der laufende Countdown und seine Generation
// (jeder Abbruch zählt hoch); welcher Neustart zuletzt an den sessions-Mod ging; für welchen Stand die Meldung
// „Kette erreicht“ schon kam.
let clearedFrom = ''
let moving: Promise<void> | undefined
let lastStop: { crons: number; tasks: number } | undefined
let queuedOwn = false
let ticking: { cancel: () => void } | undefined
let generation = 0
let fired: { id: string; at: number } | undefined
let limitShown = ''

const turnKey = (id: string): string => `turn:${id}`

// Ende des letzten Haupt-Turns dieser Session. Liegt im Store, damit es einen Reload und
// ein --resume übersteht.
async function lastTurn($: EngineInterface): Promise<number | undefined> {
  try {
    const at = await $.store.get(turnKey(await $.session.id()))
    return typeof at === 'number' ? at : undefined
  } catch {
    return undefined
  }
}

// Limits kommen nur mit einer API-Antwort. Damit eine ruhende Session nicht den Stand ihrer
// letzten Antwort zeigt, legt jede Session ihre Messung in einer Datei ab, die alle Sessions
// dieses Rechners lesen. Eine Datei statt $.store, weil die Sessions eigene Prozesse sind.
// Je Konfigurationsordner eine Datei: ein anderer Ordner kann ein anderes Konto sein.
async function sharedFile($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const dir = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!config && !dir) throw new Error('HOME ist nicht gesetzt')
  return `${config || `${dir}/.claude`}/mod-daten/verbrauch/limits.json`
}

const isLimit = (x: unknown): x is Limit => {
  if (typeof x !== 'object' || x === null) return false
  const l = x as Record<string, unknown>
  return (
    typeof l.kind === 'string' &&
    typeof l.percent === 'number' &&
    Number.isFinite(l.percent) &&
    (l.resetsAt === undefined || typeof l.resetsAt === 'string') &&
    (l.at === undefined || typeof l.at === 'number') &&
    (l.session === undefined || typeof l.session === 'string')
  )
}

// Die geteilten Messungen; fehlt die Datei oder ist sie halb geschrieben, gibt es keine.
async function readShared($: EngineInterface): Promise<Limit[]> {
  try {
    const data = JSON.parse(await $.fs.read(await sharedFile($))) as { limits?: unknown } | null
    return Array.isArray(data?.limits) ? data.limits.filter(isLimit) : []
  } catch {
    return []
  }
}

// Welche von zwei Messungen gilt. Im selben Fenster steigt der Verbrauch nur: die höhere, so
// schlägt ein falsch frischer Stempel keinen echten Stand. Sonst die jüngere, denn sie kennt den
// Reset oder das neue Fenster; ohne Zeitpunkt zählt eine Messung als älteste.
const better = (a: Limit, b: Limit): Limit => {
  const ra = parseReset(a.resetsAt)
  const rb = parseReset(b.resetsAt)
  if (ra !== undefined && rb !== undefined && Math.abs(ra - rb) < SAME_WINDOW_MS && a.percent !== b.percent) {
    return a.percent > b.percent ? a : b
  }
  const at = (a.at ?? 0) - (b.at ?? 0)
  if (at !== 0) return at > 0 ? a : b
  return a.percent >= b.percent ? a : b
}

// Je Fenster die geltende Messung, in der Reihenfolge des ersten Auftretens.
const merge = (...lists: Limit[][]): Limit[] => {
  const out = new Map<string, Limit>()
  for (const l of lists.flat()) {
    const had = out.get(l.kind)
    out.set(l.kind, had ? better(had, l) : l)
  }
  return [...out.values()]
}

const fromApi = (limits: SessionRateLimit[], at: number, session: string): Limit[] =>
  limits.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt, at: at || undefined, session }))

// Nach dem Reset ist ein Fenster leer, bis wieder jemand etwas braucht.
const current = (l: Limit, now: number): Limit => {
  const reset = parseReset(l.resetsAt)
  return reset !== undefined && reset <= now ? { kind: l.kind, percent: 0 } : l
}

// Die eigenen Limits zusammen mit den geteilten. Kam seit dem letzten Lesen eine API-Antwort
// (Kosten gestiegen oder Limits anders), ist die eigene Messung frisch und geht in die Datei.
async function limitsOf($: EngineInterface, u: SessionUsage, now: number): Promise<Limit[]> {
  const usd = u.cost?.usd
  const key = JSON.stringify(u.rateLimits)
  const answered = isBased && ((usd ?? 0) > (seenUsd ?? 0) || key !== seenLimits)
  isBased = true
  seenUsd = usd
  seenLimits = key
  if (answered && u.rateLimits.length) measuredAt = now
  const shared = await readShared($)
  const merged = merge(fromApi(u.rateLimits, measuredAt, await $.session.id()), shared)
  if (answered && u.rateLimits.length && JSON.stringify(merged) !== JSON.stringify(shared)) {
    try {
      await $.fs.write(await sharedFile($), JSON.stringify({ limits: merged }))
    } catch {
      // Ohne Ablage zeigen die anderen Sessions nur ihren eigenen Stand.
    }
  }
  return merged.map(l => current(l, now))
}

// Pickup-Datei dieser Session aus der Marke des sessions-Mods; null wenn es keine Marke gibt (Mod läuft nicht).
async function pickupOf($: EngineInterface): Promise<Pickup | null> {
  try {
    const dir = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!dir) return null
    const data = JSON.parse(await $.fs.read(`${dir}/.claude/mod-daten/sessions/${await $.session.id()}.json`)) as {
      pickup?: unknown
      file?: unknown
    } | null
    return {
      phrase: typeof data?.pickup === 'string' ? data.pickup : '',
      file: typeof data?.file === 'string' ? data.file : '',
    }
  } catch {
    return null
  }
}

// Erster Knopf: nur nachfragen. Die Nachfrage verfällt nach CONFIRM_MS.
async function askRestart($: EngineInterface): Promise<void> {
  const armedUntil = (await $.clock.now()) + CONFIRM_MS
  await update($, confirm, () => armedUntil)
  $.clock.after(CONFIRM_MS, () => {
    void update($, confirm, v => (v === armedUntil ? 0 : v)).catch(() => undefined)
  })
}

// „Ja“: lässt den sessions-Mod sichern und neu starten. Seine Antwort steht im Verlauf; gemeldet wird nur ein Fehler.
async function confirmRestart($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const until = await read($, confirm)
  if (until <= now || now < until - CONFIRM_MS + CONFIRM_MIN_MS) return
  await update($, confirm, () => 0)
  try {
    await $.command.run({ command: 'pause', args: 'selbst' })
  } catch (err) {
    $.ui.toast(`Sichern & Neustart ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
  }
}

// Hält den Store klein: Sessions, die einen Monat ruhen, fallen heraus.
async function prune($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (key.startsWith('auto:')) {
      const a = asAuto(await $.store.get(key))
      if (!a || now - a.at > KEEP_MS) await $.store.delete(key)
      continue
    }
    if (!key.startsWith('turn:')) continue
    const at = await $.store.get(key)
    if (typeof at !== 'number' || now - at > KEEP_MS) await $.store.delete(key)
  }
}

const autoKey = (id: string): string => `auto:${id}`

const freshAuto = (now: number): Auto => ({ an: false, grenze: AUTO_GRENZE, max: AUTO_MAX, kette: 0, letzter: 0, at: now })

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

// Ein Eintrag aus dem Store; ein kaputter oder fremder Wert gilt als keiner. Felder älterer Stände fallen weg.
const asAuto = (x: unknown): Auto | undefined => {
  if (typeof x !== 'object' || x === null) return undefined
  const a = x as Record<string, unknown>
  if (typeof a.an !== 'boolean' || !isNum(a.grenze) || !isNum(a.max) || !isNum(a.kette) || !isNum(a.letzter) || !isNum(a.at)) {
    return undefined
  }
  return { an: a.an, grenze: a.grenze, max: a.max, kette: a.kette, letzter: a.letzter, at: a.at }
}

// Nach /clear läuft der Prozess unter neuer ID weiter: der Eintrag zieht mit, sobald $.session.id() die neue nennt.
// Schalter, Grenze und Max. bleiben. Die Kette nur nach dem eigenen Auto-Neustart; ein /clear von Hand ist Mike.
function migrate($: EngineInterface): Promise<void> {
  if (!clearedFrom) return Promise.resolve()
  moving ??= (async () => {
    const from = clearedFrom
    const id = await $.session.id()
    if (id === from) return
    // Kam inzwischen noch ein /clear, gilt dessen ID.
    if (clearedFrom === from) clearedFrom = ''
    const now = await $.clock.now()
    const isOwn = fired !== undefined && fired.id === from && now - fired.at < FIRED_VALID_MS
    if (isOwn) fired = undefined
    const old = asAuto(await $.store.get(autoKey(from)))
    if (!old) return
    await $.store.set(autoKey(id), { ...old, kette: isOwn ? old.kette : 0, at: now })
    await $.store.delete(autoKey(from))
  })().finally(() => {
    moving = undefined
  })
  return moving
}

// Der Auto-Neustart dieser Session; undefined ohne Eintrag.
async function autoOf($: EngineInterface): Promise<Auto | undefined> {
  await migrate($)
  return asAuto(await $.store.get(autoKey(await $.session.id())))
}

// Liest den Eintrag frisch und schreibt fn(Eintrag) gleich danach, ohne Warten dazwischen: so überschreibt keine
// Änderung eine andere, die während eines früheren await kam. fn gibt undefined zurück, wenn nichts zu schreiben
// ist; ohne Eintrag gelten die Standardwerte (create) oder es bleibt beim Nichts.
async function patchAuto($: EngineInterface, fn: (a: Auto) => Auto | undefined, create = true): Promise<Auto | undefined> {
  await migrate($)
  const key = autoKey(await $.session.id())
  const now = await $.clock.now()
  const had = asAuto(await $.store.get(key)) ?? (create ? freshAuto(now) : undefined)
  const next = had && fn(had)
  if (!next) return undefined
  await $.store.set(key, { ...next, at: now })
  return next
}

// Warum es keine Pickup-Datei gibt, für Pane und Befehl.
const noPickupWhy = (p: Pickup | null | undefined): string =>
  p === null || p === undefined ? 'keine Marke vom sessions-Mod'
  : p.phrase ? `„${p.phrase}“ hat keine 🔑-Zeile in MEMORY.md`
  : 'Session ohne 🔑-Phrase'

// "400k", "400000", "0.4m" → Tokens; sonst der Grund als Text. Unter dem Kontextfenster, wenn es bekannt ist.
const parseGrenze = (text: string, window: number): number | string => {
  const hit = /^(\d+(?:[.,]\d+)?)\s*([km])?$/i.exec(text.trim())
  const unit = hit?.[2]?.toLowerCase()
  const n = hit?.[1] ? Math.round(Number(hit[1].replace(',', '.')) * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1)) : NaN
  if (!Number.isFinite(n)) return `„${text.trim()}“ ist keine Grenze: z. B. 400k, 300000 oder 0.4m.`
  if (n < GRENZE_MIN || n > GRENZE_MAX) {
    return `Grenze ${fmtTokens(n)} geht nicht: erlaubt sind ${fmtTokens(GRENZE_MIN)} bis ${fmtTokens(GRENZE_MAX)}.`
  }
  if (window > 0 && n >= window) {
    return `Grenze ${fmtTokens(n)} geht nicht: sie muss unter dem Kontextfenster (${fmtTokens(window)}) liegen.`
  }
  return n
}

const parseMax = (text: string): number | string => {
  const n = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN
  return n >= MAX_MIN && n <= MAX_MAX ? n : `„${text.trim()}“ geht nicht als Max. Neustarts: eine ganze Zahl von ${MAX_MIN} bis ${MAX_MAX}.`
}

const AUTO_USAGE =
  'Aufruf: /auto (Stand), /auto an [grenze] [max] (z. B. /auto an 300k 5), /auto aus, /auto grenze 300k, /auto max 5'

type Said = { ok: boolean; text: string }

// Hält einen Neustart an, den fire schon an den sessions-Mod gab (Sicherungs-Turn läuft oder steht an). Zwei Wege:
// die Abbruch-Datei, die der sessions-Mod vor dem /clear liest (sofort, auch mitten im Turn), und /pause abbrechen
// (läuft erst, wenn die Session ruht: $.command.run wartet darauf). Nur wenn fire hier eben auslöste.
async function stopHandedOver($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const id = await $.session.id()
  if (!fired || fired.id !== id || now - fired.at >= FIRED_VALID_MS) return
  fired = undefined
  try {
    const dir = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!dir) throw new Error('HOME ist nicht gesetzt')
    await $.fs.write(`${dir}/.claude/mod-daten/sessions/${id}.abbruch`, JSON.stringify({ at: now }))
  } catch (err) {
    $.ui.toast(`Auto-Neustart: Abbruch an den sessions-Mod ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
  }
  // Nicht aus dem /auto-Befehl heraus: ein Befehl darf keinen anderen starten, solange er läuft.
  $.clock.after(200, () => {
    void $.command.run({ command: 'pause', args: 'abbrechen' }).catch(err => {
      $.ui.toast(`Auto-Neustart: /pause abbrechen ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
    })
  })
}

// /auto und die Bedienelemente im Pane: ändert den Eintrag oder sagt, warum nicht (der alte Wert bleibt).
// Grenze oder Max. bei ausgeschaltetem Auto-Neustart: die Werte gelten erst nach dem Einschalten.
const OFF_HINT = ' Gilt erst, wenn er an ist: /auto an oder Knopf „einschalten“.'

async function autoCommand($: EngineInterface, args: string): Promise<Said> {
  const [sub = '', ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const fail = (text: string): Said => ({ ok: false, text })
  if (sub === 'aus' && !rest.length) {
    // Zuerst, vor jedem await: ein Countdown oder ein fire, das gerade wartet, schreibt danach nichts mehr.
    generation++
    const wasCounting = cancelCountdown($)
    await patchAuto($, a => ({ ...a, an: false, kette: 0 }), false)
    await stopHandedOver($)
    await refresh($)
    return { ok: true, text: wasCounting ? 'Auto-Neustart aus, der Countdown ist abgebrochen.' : 'Auto-Neustart aus.' }
  }
  const had = (await autoOf($)) ?? freshAuto(await $.clock.now())
  const u = await $.session.usage()
  // Zu Grenze und Max. bei ausgeschaltetem Auto-Neustart: wie er angeht, oder warum er hier nicht angehen kann.
  const offNote = async (): Promise<string> => {
    if (had.an) return ''
    const p = await pickupOf($)
    return p?.file ? OFF_HINT : ` Einschalten geht hier nicht: ${noPickupWhy(p)}.`
  }
  let change: Partial<Auto>
  let text: string
  if (sub === '') {
    const p = await pickupOf($)
    const k = `Kette ${had.kette}/${had.max}`
    return {
      ok: true,
      text: had.an
        ? `Auto-Neustart an: ab ${fmtTokens(had.grenze)} Kontext (jetzt ${fmtTokens(u.context.tokens ?? 0)}), ${k}` +
          `${had.kette >= had.max ? ', wartet auf dich' : ''}${p?.file ? '' : `; löst nicht aus: ${noPickupWhy(p)}`}.\n${AUTO_USAGE}`
        : `Auto-Neustart aus (Grenze ${fmtTokens(had.grenze)}, höchstens ${had.max} in Folge)` +
          `${p?.file ? '' : `; einschalten geht hier nicht: ${noPickupWhy(p)}`}.\n${AUTO_USAGE}`,
    }
  }
  if (sub === 'an' && rest.length <= 2) {
    const p = await pickupOf($)
    if (!p?.file) return fail(`Auto-Neustart bleibt aus: ${noPickupWhy(p)}. Er braucht eine Pickup-Datei (🔑-Zeile in MEMORY.md).`)
    const grenze = parseGrenze(rest[0] ?? String(had.grenze), u.context.window)
    if (typeof grenze === 'string') return fail(rest[0] === undefined ? `${grenze} Mit anderer Grenze: /auto an 150k` : grenze)
    const max = rest[1] === undefined ? had.max : parseMax(rest[1])
    if (typeof max === 'string') return fail(max)
    change = { an: true, grenze, max, kette: 0 }
    text =
      `Auto-Neustart an: ab ${fmtTokens(grenze)} Kontext sichert diese Session am Turn-Ende ihren Stand in ` +
      `${p.file.split(/[\\/]/).pop() ?? p.file}, startet frisch mit „${p.phrase}“ und arbeitet weiter, höchstens ` +
      `${max}-mal in Folge ohne dich. Aus: /auto aus.`
  } else if (sub === 'grenze' && rest.length === 1) {
    const grenze = parseGrenze(rest[0] ?? '', u.context.window)
    if (typeof grenze === 'string') return fail(grenze)
    change = { grenze }
    text = `Auto-Neustart: Grenze jetzt ${fmtTokens(grenze)}.${await offNote()}`
  } else if (sub === 'max' && rest.length === 1) {
    const max = parseMax(rest[0] ?? '')
    if (typeof max === 'string') return fail(max)
    change = { max }
    text =
      `Auto-Neustart: höchstens ${max} Neustarts in Folge.` +
      (had.an && had.kette >= max ? ` Die Kette steht schon bei ${had.kette}: sie wartet, bis du schreibst.` : '') +
      (await offNote())
  } else {
    return fail(AUTO_USAGE)
  }
  // Frisch gelesen geschrieben: was inzwischen kam (etwa die Kette aus fire), bleibt.
  await patchAuto($, a => ({ ...a, ...change }))
  await refresh($)
  return { ok: true, text }
}

// −/+ im Pane (auch am Telefon, das keine Felder zeichnet): Grenze in 50k-Schritten, Max. Neustarts um 1.
async function stepAuto($: EngineInterface, what: 'grenze' | 'max', dir: 1 | -1): Promise<void> {
  try {
    const a = (await autoOf($)) ?? freshAuto(await $.clock.now())
    let value = what === 'max' ? a.max + dir : a.grenze + dir * GRENZE_STEP
    // Abwärts bei einer Grenze über dem Fenster: gleich auf die höchste erlaubte Stufe darunter.
    const window = (await $.session.usage()).context.window
    if (what === 'grenze' && dir < 0 && window > 0 && value >= window) value = Math.floor((window - 1) / GRENZE_STEP) * GRENZE_STEP
    const said = await autoCommand($, `${what} ${value}`)
    if (!said.ok || said.text.endsWith(OFF_HINT)) $.ui.toast(said.text, { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`Auto-Neustart: Änderung ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
  }
}

// Eingabefeld, Knopf an/aus: wie der Befehl, eine Absage als Meldung.
async function autoInput($: EngineInterface, args: string): Promise<void> {
  try {
    const said = await autoCommand($, args)
    // Gesetzt, aber der Schalter ist aus: sagen, sonst sieht der Wert im Feld wie „eingerichtet“ aus.
    if (said.ok && said.text.endsWith(OFF_HINT)) $.ui.toast(said.text, { timeoutMs: 10_000 })
    if (said.ok) return
    $.ui.toast(said.text, { timeoutMs: 10_000 })
    // Nach einer Absage neu zeichnen: das Feld zeigt dann wieder den alten Wert.
    await refresh($)
  } catch (err) {
    $.ui.toast(`Auto-Neustart: Änderung ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
  }
}

const stopTicking = (): void => {
  ticking?.cancel()
  ticking = undefined
}

// Bricht einen laufenden Countdown ab; true, wenn einer lief. Zählt die Generation hoch, damit ein fire, das
// schon läuft, nach seinem nächsten await aufhört.
function cancelCountdown($: EngineInterface, why?: string): boolean {
  generation++
  if (!ticking) return false
  stopTicking()
  void update($, countdown, () => 0).catch(() => undefined)
  if (why) $.ui.toast(why, { timeoutMs: 6_000 })
  return true
}

// Countdown vor dem Auto-Neustart: Toast, Pane-Zeile mit Abbrechen, danach fire.
function startCountdown($: EngineInterface, id: string): void {
  if (ticking) return
  const gen = ++generation
  let left = COUNTDOWN_S
  void update($, countdown, () => left).catch(() => undefined)
  $.ui.toast(
    `Auto-Neustart in ${COUNTDOWN_S} s: Die Session sichert ihren Stand und startet frisch. Abbrechen: schreiben, ` +
      '/auto aus oder Taste x im /verbrauch-Pane.',
    { timeoutMs: COUNTDOWN_S * 1_000 },
  )
  ticking = $.clock.every(1_000, () => {
    left--
    if (left > 0) {
      void update($, countdown, () => left).catch(() => undefined)
      return
    }
    stopTicking()
    void fire($, id, gen)
  })
}

// Ende des Countdowns: Kette zählen, dann sichert und startet der sessions-Mod (/pause auto). Nach jedem await
// prüft fire die Generation: ein Abbruch in der Zwischenzeit (Knopf, /auto aus, Prompt, Turn) gewinnt. Gemeldet
// wird nur, was nicht klappte; die Antwort des sessions-Mods steht im Verlauf.
async function fire($: EngineInterface, id: string, gen: number): Promise<void> {
  try {
    await update($, countdown, () => 0)
    if (gen !== generation || turns.size || (await $.session.id()) !== id || gen !== generation) return
    const now = await $.clock.now()
    if (gen !== generation) return
    // Frisch gelesen: nur wenn noch an, nie ein an über ein aus schreiben.
    const counted = await patchAuto($, a => (a.an && gen === generation ? { ...a, kette: a.kette + 1, letzter: now } : undefined), false)
    if (!counted || gen !== generation) return
    fired = { id, at: now }
    void refresh($)
    const { text = '' } = await $.command.run({ command: 'pause', args: 'auto' })
    // Der sessions-Mod startet nicht neu (keine Pickup-Datei, läuft schon, alte Version ohne auto): melden.
    // Kein Auto-Neustart vorgemerkt: fired vergessen, sonst bricht ein späteres /auto aus Mikes eigenes /pause ab.
    if (/^(Kein Neustart|Läuft schon|Aufruf)/.test(text)) fired = undefined
    if (/^(Kein Neustart|Läuft schon|Aufruf)/.test(text)) $.ui.toast(`Auto-Neustart: ${text.slice(0, 200)}`, { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`Auto-Neustart ging nicht: ${String(err).slice(0, 160)}`, { timeoutMs: 10_000 })
  }
}

// Läuft im Hintergrund noch etwas? Jeder Agent, der nicht beendet ist, auch ein wartendes Teammate (idle) oder
// ein eben aktiver Loop ohne Listeneintrag: /clear darf keinen abschneiden. Shells, Monitore, Workflows dazu.
const isAnythingAlive = (b: Background, now: number): boolean =>
  Object.values(b.agents).some(a => (a.status === 'unlisted' ? isRecentUnlisted(a, now) : a.endedAt === undefined)) ||
  Object.values(b.shells).some(s => s.endedAt === undefined)

// Kurz nach dem Ende eines Haupt-Turns: löst den Countdown aus, wenn alles passt. id ist die Session dieses
// Turns: kam inzwischen ein /clear (der sessions-Mod nach dem Sicherungs-Turn) oder ein neuer Turn, nichts tun.
async function maybeTrigger($: EngineInterface, id: string, isAnswer: boolean): Promise<void> {
  if (turns.size || (await $.session.id()) !== id) return
  const a = await autoOf($)
  if (!a?.an || !isAnswer || ticking || turns.size || queuedOwn) return
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (tokens < a.grenze) return
  // Eine /loop-Session verlöre durch /clear ihre Crons; jede Hintergrund-Arbeit, auch ein Subagent, wartet auf
  // ihr Ende.
  if (!lastStop || lastStop.crons !== 0 || lastStop.tasks !== 0) return
  const now = await $.clock.now()
  if (isAnythingAlive(await read($, bg), now)) return
  if (!(await pickupOf($))?.file) return
  if (a.kette >= a.max) {
    if (limitShown !== `${id}:${a.kette}`) {
      limitShown = `${id}:${a.kette}`
      $.ui.toast(`Auto-Neustart: ${a.kette}/${a.max} in Folge erreicht, die Session wartet auf dich.`, { timeoutMs: 10_000 })
    }
    return
  }
  if (now - a.letzter < AUTO_GAP_MS) return
  if (turns.size || (await $.session.id()) !== id) return
  startCountdown($, id)
}

// Mike schreibt (Tastatur oder Telefon): ein Countdown bricht ab, die Kette zählt von vorn. Einen schon
// übergebenen Neustart hält der sessions-Mod selbst an (sein prompt.submit sieht denselben Prompt).
async function ownPrompt($: EngineInterface, isQueued: boolean): Promise<void> {
  try {
    if (isQueued) queuedOwn = true
    limitShown = ''
    cancelCountdown($, 'Auto-Neustart abgebrochen: du hast geschrieben.')
    fired = undefined
    if ((await autoOf($))?.kette) {
      await patchAuto($, a => (a.kette ? { ...a, kette: 0 } : undefined), false)
      void refresh($)
    }
  } catch {
    // Dann zählt die Kette weiter; die Bremse bleibt.
  }
}

// Prod-Deploys, die eine Auto-Kette ohne Mike nicht starten darf: ansible-playbook ohne --check, --syntax-check
// oder -C; vercel mit --prod; wrangler deploy/publish, auch pages deploy und versions deploy. Nur an Befehlsstelle:
// am Anfang, nach ; && || | $( ` oder ( , auch hinter sudo, env VAR=…, VAR=…, time/nohup/nice/timeout N,
// uv/poetry run, bash/sh/zsh -c '…', einem Pfad oder npx.
// Bewusst nicht erkannt (Sperre ist eine zweite Linie hinter der Halt-Liste im Prompt): Skripte und Makefiles
// (./deploy.sh, make deploy, npm run deploy), Variablen und eval, xargs, ssh auf einen anderen Rechner, Deploys,
// die ein git push in der CI auslöst.
const AT_COMMAND =
  String.raw`(?:^|[;&|\n(` + '`' + String.raw`])\s*(?:(?:sudo|env)(?:\s+(?:-\S+|\w+=\S*))*\s+|\w+=\S*\s+|` +
  String.raw`(?:time|nohup|nice|command|exec)(?:\s+-\S+)*\s+|timeout(?:\s+-\S+)*\s+\S+\s+|` +
  String.raw`(?:uv|poetry|pipenv|pdm|hatch)\s+run(?:\s+-\S+)*\s+)*` +
  String.raw`(?:(?:ba|z|da)?sh\s+-c\s+['"]\s*)?(?:\S*/)?(?:(?:npx|bunx|pnpx)\s+|(?:pnpm|yarn)\s+(?:dlx\s+)?)?`
const ANSIBLE = new RegExp(`${AT_COMMAND}ansible-playbook(?=\\s|$|['"])`, 'g')
const VERCEL = new RegExp(`${AT_COMMAND}vercel(?=\\s|$|['"])`, 'g')
const WRANGLER = new RegExp(`${AT_COMMAND}wrangler\\s+(?:(?:pages|versions)\\s+)?(?:deploy|publish)\\b`)
// Der eigene Teilbefehl hinter einem Treffer, bis zum nächsten Trenner oder Anführungszeichen. Endet er an einem
// Anführungszeichen vor einem --check, gilt er als Deploy: lieber zu streng.
const restOf = (command: string, end: number): string => command.slice(end).split(/[;&|\n`)'"]/)[0] ?? ''
const hits = (re: RegExp, command: string): string[] =>
  [...command.matchAll(re)].map(m => restOf(command, (m.index ?? 0) + m[0].length))
const isDeploy = (command: string): boolean =>
  hits(ANSIBLE, command).some(rest => !/(?:^|\s)(?:--check|--syntax-check|-C)(?=\s|=|$)/.test(rest)) ||
  hits(VERCEL, command).some(rest => /(?:^|\s)--prod(?=\s|=|$)/.test(rest)) ||
  WRANGLER.test(command)

const DEPLOY_HINT =
  'Ein Prod-Deploy (ansible-playbook ohne --check, vercel --prod, wrangler deploy/publish) braucht Mike. Nicht umgehen: ' +
  'schreib in die Pickup-Datei `Auto-Weiter: nein — Prod-Deploy wartet auf Mike`, berichte kurz und warte, bis Mike schreibt.'
// Ohne lesbaren Schalter: lieber sperren als einen Deploy ohne Mike durchlassen.
const DEPLOY_UNKNOWN = `Gesperrt vom verbrauch-Mod: Ob eine Auto-Neustart-Kette läuft, war nicht lesbar. ${DEPLOY_HINT}`

// Sperrt den Deploy, solange der Auto-Neustart an ist und seit dem letzten Prompt von Mike schon einer lief.
async function deployLock($: EngineInterface): Promise<string | undefined> {
  const a = await autoOf($)
  return a?.an && a.kette >= 1
    ? `Gesperrt vom verbrauch-Mod: Diese Session läuft in einer Auto-Neustart-Kette ohne Mike (${a.kette}/${a.max}). ${DEPLOY_HINT}`
    : undefined
}

// Die Pickup-Phrase, mit der die Session begann ("mods pickup"), für den Hinweis beim Anhalten.
async function pickupPhrase($: EngineInterface): Promise<string | undefined> {
  const rows = await $.session.messages()
  for (const row of rows.slice(0, 10)) {
    if (row.role !== 'user' || row.text.includes('<')) continue
    const hit = /^\s*(.{1,40}?\bpickup)\b/i.exec(row.text)
    if (hit) return hit[1]
  }
  return undefined
}

// Meldet jede Schwelle einmal: Kontext je Stufe, Limits je Fenster und Stufe.
async function warn($: EngineInterface, u: SessionUsage, now: number): Promise<void> {
  const before = await read($, warned)
  let after: Warned = before
  const tokens = u.context.tokens ?? 0
  const level = tokens >= ALARM ? 2 : tokens >= WARN ? 1 : 0
  if (level > before.context) {
    $.ui.toast(
      level === 2
        ? `Kontext über ${fmtTokens(ALARM)}: Session per Pickup sichern und neu starten lohnt sich jetzt deutlich.`
        : `Kontext über ${fmtTokens(WARN)}: Jeder Call liest das komplett neu. Ab hier spart ein Session-Wechsel spürbar Tokens.`,
      { timeoutMs: 10_000 },
    )
    after = { ...after, context: level }
  } else if (level < before.context) {
    // Nach /compact oder /clear wieder scharf.
    after = { ...after, context: level }
  }
  for (const l of u.rateLimits) {
    const label = LABEL[l.kind]
    const hit = LIMIT_LEVELS.find(p => l.percentUsed >= p)
    if (!label || hit === undefined) continue
    const window = l.resetsAt ?? ''
    const [prevWindow, prevHit] = (after.limits[l.kind] ?? '|').split('|')
    if (prevWindow === window && Number(prevHit) >= hit) continue
    const reset = fmtReset(l.resetsAt, now)
    $.ui.toast(`${label}-Limit bei ${Math.round(l.percentUsed)} %${reset ? `, Reset ${reset}` : ''}.`, { timeoutMs: 10_000 })
    after = { ...after, limits: { ...after.limits, [l.kind]: `${window}|${hit}` } }
  }
  if (after !== before) await update($, warned, () => after)
}

// Schreibt nur, wenn sich etwas geändert hat: jeder Schreibvorgang zeichnet das Pane neu.
async function updateBg($: EngineInterface, fn: (b: Background) => Background): Promise<Background> {
  const before = await read($, bg)
  if (JSON.stringify(fn(before)) === JSON.stringify(before)) return before
  return update($, bg, fn)
}

// Gleicht die Agenten mit $.agent.list() ab und merkt sich beim ersten Mal, wo die Engine beim
// API-Gegenwert stand. Scheitert etwas, bleibt der letzte Stand: Statuszeile und Warnungen laufen weiter.
async function syncBackground(
  $: EngineInterface,
  now: number,
  usd: number | undefined,
  startedAt: number,
): Promise<Background | undefined> {
  try {
    const list = await $.agent.list().catch(() => undefined)
    return await updateBg($, b => {
      const listed = list ? withList(b, list, now) : b
      if (usd === undefined) return listed
      const since = listed.since
      if (!since) return { ...listed, since: { at: now, usd, from: startedAt } }
      // Die Engine zählt nach /clear wieder ab 0 (neues startedAt), das Atom ist dann auch leer. Kam der Startwert
      // noch vom alten Stand (erstes Lesen gleich nach dem /clear), gilt ab dem neuen Start 0; ein Wert unter dem
      // Startwert heisst dasselbe, auch wenn startedAt beim Lesen noch der alte war.
      if (since.from !== undefined && startedAt !== since.from) return { ...listed, since: { at: startedAt, usd: 0, from: startedAt } }
      return usd < since.usd ? { ...listed, since: { ...since, usd: 0 } } : listed
    })
  } catch {
    return read($, bg).catch(() => undefined)
  }
}

async function reconcile($: EngineInterface, tasks: readonly TaskSummary[]): Promise<void> {
  try {
    const now = await $.clock.now()
    await updateBg($, b => withTasks(b, tasks, now))
    void refresh($)
  } catch {
    // Dann gleicht erst das nächste Turn-Ende ab.
  }
}

async function refresh($: EngineInterface): Promise<void> {
  // Läuft schon einer, danach noch einmal: sonst ginge etwa der Turn-Beginn bis zum nächsten Takt verloren.
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    const u = await $.session.usage()
    const now = await $.clock.now()
    const s: Snapshot = {
      at: now,
      limits: await limitsOf($, u, now),
      tokens: u.context.tokens,
      window: u.context.window,
      usd: u.cost?.usd,
      startedAt: u.startedAt,
      lastTurn: (await lastTurn($)) ?? 0,
      running: turns.size > 0,
      pickup: await pickupOf($),
      auto: (await autoOf($).catch(() => undefined)) ?? null,
    }
    await update($, snap, () => s)
    const b = await syncBackground($, now, u.cost?.usd, u.startedAt)
    const text = statusLine(s, b ?? { agents: {}, shells: {}, main: { calls: 0, usd: 0, unpriced: false } })
    if (text !== shown) {
      shown = text
      $.ui.status(text)
    }
    await warn($, u, now)
  } catch {
    // Anzeige ist Komfort: ein Fehler darf nie eine Session stören.
  } finally {
    busy = false
    if (again) {
      again = false
      void refresh($)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // claude -p (Skripte) hat keine Statuszeile: dort nichts tun.
    active = e.isInteractive
    if (!active) return started
    shown = undefined
    turns.clear()
    await update($, confirm, () => 0)
    measuredAt = 0
    isBased = false
    clearedFrom = ''
    lastStop = undefined
    queuedOwn = false
    limitShown = ''
    fired = undefined
    generation++
    stopTicking()
    await update($, countdown, () => 0)
    await $.command.register({
      name: 'verbrauch',
      description: 'Verbrauch als Grafik: Limits mit Prognose, Kontext, Cache warm oder kalt',
    })
    // Läuft sofort, auch mitten in einem Turn: /auto aus soll nicht bis zum Turn-Ende warten.
    await $.command.register({
      name: 'auto',
      description: 'Auto-Neustart dieser Session: ab einer Kontextgrenze selbst sichern, frisch starten, weiterarbeiten',
      argumentHint: '[an [grenze] [max]|aus|grenze 300k|max 5]',
      immediate: true,
    })
    await prune($).catch(() => undefined)
    await refresh($)
    $.clock.every(EVERY_MS, () => {
      void refresh($)
    })
    return started
  })

  on('command.run', { command: 'verbrauch' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Verbrauch geschlossen.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Verbrauch' })
    return { text: 'Verbrauch offen, /verbrauch schliesst ihn wieder.' }
  })

  on('command.run', { command: 'auto' }, async ($, e) => {
    try {
      return { text: (await autoCommand($, e.args)).text }
    } catch (err) {
      return { text: `Auto-Neustart: ging nicht: ${String(err).slice(0, 160)}` }
    }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (active) {
      turns.add(e.turnId)
      // Ein neuer Turn (auch ein Cron oder eine Benachrichtigung): die Session ruht nicht mehr.
      lastStop = undefined
      queuedOwn = false
      cancelCountdown($, 'Auto-Neustart abgebrochen: ein neuer Turn läuft.')
      await refresh($)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    turns.delete(e.turnId)
    if (active && !e.agentId) {
      // Jeder Haupt-Turn hält den Cache warm: sein Ende ist der Massstab für die Sperre.
      try {
        await $.store.set(turnKey(await $.session.id()), await $.clock.now())
      } catch {
        // Ohne Zeitstempel hält die Sperre nur nicht an.
      }
    }
    if (active) await refresh($)
    if (active && !e.agentId) {
      // Auto-Neustart: erst prüfen, wenn auch classic.Stop dieses Turns da ist, und nur für die Session dieses
      // Turns (nach dem Sicherungs-Turn macht der sessions-Mod gleich /clear).
      const isAnswer = e.reason === 'answer'
      const id = await $.session.id()
      $.clock.after(TRIGGER_DELAY_MS, () => {
        void maybeTrigger($, id, isAnswer).catch(() => undefined)
      })
    }
    return done
  })

  // Jeder API-Aufruf, im Haupt-Loop oder in einem Agenten: Tokens zählen und in Dollar umrechnen.
  // Erst nach der Antwort und ohne darauf zu warten, damit der Aufruf selbst nie hängt.
  on('turn.step', async function* ($, e, next) {
    const done = yield* next(e)
    if (active && done?.usage) {
      const usage = done.usage
      void $.clock
        .now()
        .then(now => updateBg($, b => withStep(b, e.agentId, usage, now)))
        .then(() => refresh($))
        .catch(() => undefined)
    }
    return done
  })

  // Eine Shell im Hintergrund (run_in_background oder Ctrl+B): ab jetzt in der Liste. Davor die Deploy-Sperre
  // des Auto-Neustarts: in einer Kette ohne Mike kein Prod-Deploy (auch nicht aus einem Subagenten).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (active && isDeploy(e.command)) {
      const deny = await deployLock($)
      if (deny) return { deny }
    }
    const ran = await next(e)
    try {
      const id = ran.deny === undefined && !ran.isError ? ran.result?.backgroundTaskId : undefined
      if (active && id) {
        const description = e.description || e.command.slice(0, 80)
        void $.clock
          .now()
          .then(now => updateBg($, b => withShell(b, { id, kind: 'shell', description, startedAt: now })))
          .then(() => refresh($))
          .catch(() => undefined)
      }
    } catch {
      // Anzeige ist Komfort: der Aufruf geht so oder so durch.
    }
    return ran
  }).catch(($, e, next) => (next.called || !active || !isDeploy(e.command) ? next(e) : { deny: DEPLOY_UNKNOWN }))

  // Der Vorschlag der Engine nach einem Turn kostet einen eigenen Aufruf über den ganzen Kontext, den
  // kein turn.step zeigt. Zählen, damit der Rest zur Engine einen Namen hat.
  on('prompt.suggest', { origin: { kind: 'suggestion' } }, async ($, e, next) => {
    const shown = await next(e)
    if (active) void updateBg($, b => ({ ...b, suggestions: (b.suggestions ?? 0) + 1 })).catch(() => undefined)
    return shown
  }).catch(($, e, next) => next(e))

  // Meldet die Engine das Ende einer Hintergrund-Arbeit, gilt sie gleich als fertig.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    if (active && e.text.includes('<task-id>')) {
      const text = e.text
      void $.clock
        .now()
        .then(now => updateBg($, b => withNotified(b, text, now)))
        .then(() => refresh($))
        .catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Beim Ende jedes Turns nennt die Engine, was im Hintergrund noch läuft: was fehlt, ist fertig. Kommt kurz vor
  // turn.complete; der Auto-Neustart merkt sich Crons und jede Hintergrund-Arbeit, Subagenten eingeschlossen.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    if (active) {
      lastStop = {
        crons: Array.isArray(e.session_crons) ? e.session_crons.length : -1,
        tasks: Array.isArray(e.background_tasks) ? e.background_tasks.length : -1,
      }
    }
    if (active && Array.isArray(e.background_tasks)) await reconcile($, e.background_tasks)
    return done
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    if (active && Array.isArray(e.background_tasks)) await reconcile($, e.background_tasks)
    return done
  }).catch(($, e, next) => next(e))

  // Die Engine hat neu gemessen: gleich lesen, statt auf den nächsten Takt zu warten.
  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    if (active) await refresh($)
    return done
  })

  // /clear (von Hand oder beim Auto-Neustart): der Prozess läuft unter neuer ID weiter, ohne session.start. Der
  // Auto-Neustart zieht mit, sobald die neue ID da ist (spätestens beim nächsten Lesen); ein Countdown endet.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (active && e.reason === 'clear') {
      clearedFrom = e.sessionId
      generation++
      stopTicking()
      lastStop = undefined
      queuedOwn = false
      $.clock.after(300, () => {
        void migrate($)
          .then(() => refresh($))
          .catch(() => undefined)
      })
    }
    return done
  })

  // Cache-Sperre: Ein Prompt in eine grosse Session nach über einer Stunde Pause schreibt den
  // ganzen Kontext neu. Einmal anhalten, damit Mike zwischen Weitermachen und Pickup wählt.
  // Derselbe Hook (ohne Matcher, ein zweiter wäre eine Wiederholung) meldet dem Auto-Neustart Mikes Prompts.
  on('prompt.submit', async ($, e, next) => {
    // Nur was Mike selbst abschickt; Benachrichtigungen, Loops und andere Sessions laufen durch.
    const own = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    // Auto-Neustart: Mike ist da. Auch ein angehaltener Prompt zählt.
    if (active && own) await ownPrompt($, e.turnId !== undefined)
    if (!active || !own || e.turnId) return next(e)
    const last = await lastTurn($)
    const now = await $.clock.now()
    if (last === undefined || now - last < COLD_MS) return next(e)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (tokens < HOLD_FROM || (await read($, held)) === last) return next(e)
    // Ohne Modellnamen gilt der übliche Faktor.
    const factor = coldFactor(await $.session.model().catch(() => ''))
    const cost =
      `Cache abgelaufen, letzte Antwort vor ${fmtIdle(now - last)}: Dieser Prompt schreibt ` +
      `${fmtTokens(tokens)} Kontext neu, etwa ${factor}-mal so teuer wie das Lesen aus dem warmen Cache.`
    // Ein Bild käme nicht zurück ins Feld: dann nur melden. Ebenso vom Telefon (Remote Control): Den Grund des
    // Verwerfens, Toasts und das Feld zeigt nur das Terminal, einen Weg in die App hat ein Plugin nicht. Dort
    // verschwände der Prompt sonst still, und das Feld überschriebe im Terminal einen Entwurf.
    if (e.attachments?.length || e.origin.kind === 'bridge') {
      $.ui.toast(cost, { timeoutMs: 10_000 })
      return next(e)
    }
    await update($, held, () => last)
    const phrase = await pickupPhrase($).catch(() => undefined)
    // Erst nach dem Verwerfen zurück ins Feld, sonst räumt die Eingabe es wieder ab.
    void $.clock
      .sleep(100)
      .then(() => $.prompt.fill({ text: e.text }))
      .catch(() => undefined)
    return {
      drop:
        `${cost} Enter sendet ihn trotzdem. Günstiger: Ctrl+C, /clear und ` +
        `${phrase ? `„${phrase}“` : 'die Pickup-Phrase (Liste: /pickups)'}.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Felder nur, wo die Oberfläche sie zeichnet (nicht in der Mobile-App): dort −/+ und der Befehl. Nach e.surface,
    // denn die Engine ergänzt fehlende Elemente der Tabelle als leere Fragmente.
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    const s = await read($, snap)
    if (!s.at) return <Text dimColor>Lese den Verbrauch …</Text>
    const self = await $.session.id()
    const confirming = (await read($, confirm)) > (await $.clock.now())
    const width = Math.max(10, Math.min(32, e.props.bodyColumns - LABEL_W - 8))

    const bar = (segs: Segment[]) =>
      segs.map(seg => (
        <Text color={seg.color} dimColor={seg.isEmpty}>
          {seg.text}
        </Text>
      ))
    const label = (text: string) => (
      <Box width={LABEL_W} flexShrink={0}>
        <Text bold>{text}</Text>
      </Box>
    )
    const detail = (children: RenderChildren) => (
      <Box paddingLeft={LABEL_W} flexDirection="row" flexWrap="wrap">
        {children}
      </Box>
    )

    const limitRows = s.limits
      .filter(l => TITLE[l.kind])
      .map(l => {
        const reset = parseReset(l.resetsAt)
        const pace = paceOf(l, s.at)
        const resetText = reset === undefined ? '' : `Reset ${fmtWhen(reset, s.at)}, ${fmtLeft(reset - s.at)}`
        const age = ageOf(l, s.at)
        const other = l.session !== undefined && l.session !== self
        const measureText =
          age !== undefined ? `Stand vor ${fmtIdle(age)}${other ? ', aus einer anderen Session' : ''}`
          : other ? 'Stand aus einer anderen Session'
          : ''
        const paceLine =
          pace === undefined ? undefined
          : pace.kind === 'early' ? <Text dimColor>Tempo: für eine Prognose noch zu früh</Text>
          : pace.kind === 'past' ? <Text dimColor>Fenster abgelaufen, neuer Stand nach dem nächsten Call</Text>
          : pace.kind === 'full' ? <Text color="error">Limit erreicht</Text>
          : pace.hitAt !== undefined ? (
            <Text color="error">{`Tempo → Limit um ${fmtWhen(pace.hitAt, s.at)}, vor dem Reset ✖`}</Text>
          ) : pace.percent >= 80 ? (
            <Text color="warning">{`Tempo → ~${Math.round(pace.percent)} % beim Reset, knapp`}</Text>
          ) : (
            <Text color="success">{`Tempo → ~${Math.round(pace.percent)} % beim Reset ✓`}</Text>
          )
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              {label(TITLE[l.kind] ?? l.kind)}
              {bar(gauge(l.percent, 100, LIMIT_ZONES, width))}
              <Text bold color={zoneColor(l.percent, LIMIT_ZONES)}>{`  ${Math.round(l.percent)} %`}</Text>
            </Box>
            {detail(
              <Text>
                <Text dimColor>{resetText}</Text>
                {resetText && paceLine ? <Text dimColor>{' · '}</Text> : ''}
                {paceLine ?? ''}
              </Text>,
            )}
            {measureText ? detail(<Text dimColor>{measureText}</Text>) : ''}
          </Box>
        )
      })

    const tokens = s.tokens
    const contextRow =
      tokens === undefined ? (
        <Box flexDirection="row">
          {label('Kontext')}
          <Text dimColor>noch keine Antwort in dieser Session</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {label('Kontext')}
            {bar(gauge(tokens, Math.max(CONTEXT_SCALE, tokens), CONTEXT_ZONES, width))}
            <Text bold color={zoneColor(tokens, CONTEXT_ZONES)}>{`  ${fmtTokens(tokens)}`}</Text>
          </Box>
          {detail(
            tokens >= ALARM ? (
              <Text color="error">{`über ${fmtTokens(ALARM)}: Pickup sichern und neu starten`}</Text>
            ) : tokens >= WARN ? (
              <Text color="warning">{`über ${fmtTokens(WARN)}: jeder Call liest das komplett neu`}</Text>
            ) : (
              <Text dimColor>{`Warnung ab ${fmtTokens(WARN)} · wechseln ab ${fmtTokens(ALARM)}`}</Text>
            ),
          )}
        </Box>
      )

    // Auto-Neustart: Schalter, Grenze und Max. Neustarts (Feld oder −/+), Countdown mit Abbrechen.
    const auto = s.auto ?? freshAuto(0)
    const left = await read($, countdown)
    const hasFile = Boolean(s.pickup?.file)
    const steppers = (what: 'grenze' | 'max') => (
      <Box flexDirection="row">
        <Text> </Text>
        <Button key={`${what}-`} label="−" onPress={() => stepAuto($, what, -1)} />
        <Button key={`${what}+`} label="+" onPress={() => stepAuto($, what, 1)} />
      </Box>
    )
    // Der Zustand steht im Text (○/●), der Knopf nennt nur, was er tut: „an“ oder „aus“ allein las sich wie der
    // Zustand und schaltete dann das Gegenteil.
    const autoState =
      !auto.an ? '○ aus'
      : auto.kette >= auto.max ? `● an · Kette ${auto.kette}/${auto.max} erreicht, wartet auf dich`
      : `● an · ab ${fmtTokens(auto.grenze)} · Kette ${auto.kette}/${auto.max}`
    const autoRows = (
      <Box flexDirection="column">
        {detail(
          <Box flexDirection="row">
            {hasFile ? (
              <Text color={auto.an ? 'success' : undefined} dimColor={!auto.an}>{`Auto-Neustart: ${autoState}`}</Text>
            ) : (
              <Text dimColor>{`Auto-Neustart: nicht möglich, ${noPickupWhy(s.pickup)}`}</Text>
            )}
            {hasFile || auto.an ? <Text> </Text> : ''}
            {hasFile || auto.an ? (
              <Button key="auto" label={auto.an ? 'ausschalten' : 'einschalten'} onPress={() => autoInput($, auto.an ? 'aus' : 'an')} />
            ) : (
              ''
            )}
          </Box>,
        )}
        {hasFile && Input
          ? detail(
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Input
                    key="auto-grenze"
                    label="Grenze "
                    value={fmtTokens(auto.grenze)}
                    submitLabel="übernehmen"
                    onSubmit={value => autoInput($, `grenze ${value}`)}
                  />
                  {steppers('grenze')}
                </Box>
                <Box flexDirection="row">
                  <Input
                    key="auto-max"
                    label="Max. Neustarts "
                    value={String(auto.max)}
                    submitLabel="übernehmen"
                    onSubmit={value => autoInput($, `max ${value}`)}
                  />
                  {steppers('max')}
                </Box>
              </Box>,
            )
          : hasFile
            ? detail(
                <Box flexDirection="row" flexWrap="wrap">
                  <Text dimColor>{`Grenze ${fmtTokens(auto.grenze)}`}</Text>
                  {steppers('grenze')}
                  <Text dimColor>{` · Max. Neustarts ${auto.max}`}</Text>
                  {steppers('max')}
                </Box>,
              )
            : ''}
        {left > 0
          ? detail(
              <Box flexDirection="row">
                <Text bold color="warning">{`Auto-Neustart in ${left} s`}</Text>
                <Text> </Text>
                <Button
                  key="auto-abbrechen"
                  label="Abbrechen"
                  hotkey="x"
                  onPress={() => {
                    cancelCountdown($, 'Auto-Neustart abgebrochen.')
                  }}
                />
              </Box>,
            )
          : ''}
      </Box>
    )

    const cache = cacheOf(s)
    const cacheText =
      cache === undefined ? <Text dimColor>noch kein Turn in dieser Session</Text>
      : cache.state === 'running' ? <Text color="success">● aktiv, ein Turn läuft</Text>
      : cache.state === 'warm' ? (
        <Text color={cache.leftMs <= 10 * MIN ? 'warning' : 'success'}>
          {`● warm, läuft in ${Math.ceil(cache.leftMs / MIN)} Min. ab`}
        </Text>
      ) : (
        <Text color="suggestion">
          {`❄ kalt seit ${fmtIdle(cache.idleMs)}${tokens ? ` · nächster Prompt schreibt ${fmtTokens(tokens)} neu` : ''}`}
        </Text>
      )

    // Hintergrund: was läuft und was es kostet. Der Balken ist der Anteil an allem, was seit Beginn der
    // Zählung gezählt wurde. Ein Fehler hier kostet nur diesen Block, nicht das Pane.
    let background: RenderChildren
    try {
      background = await backgroundBlock()
    } catch (err) {
      background = (
        <Box flexDirection="row">
          {label('Hintergrund')}
          <Text dimColor>{`Anzeige ging nicht: ${String(err).slice(0, 120)}`}</Text>
        </Box>
      )
    }

    async function backgroundBlock(): Promise<RenderChildren> {
      const b = await read($, bg)
      const now = await $.clock.now()
      const working = busyOf(b, now)
      const agentsUsd = Object.values(b.agents).reduce((sum, a) => sum + a.usd, 0) + (b.prunedUsd ?? 0)
      const counted = agentsUsd + b.main.usd
      const total = Math.max(counted, 0.01)
      type Item = { at: number; isActive: boolean; row: RenderChildren }
      const items: Item[] = []
      for (const a of Object.values(b.agents)) {
        const end = agentEnd(a, now)
        const isActive = isAgentActive(a)
        const isRecent = isRecentUnlisted(a, now)
        if (end !== undefined && now - end > BG_SHOWN_MS) continue
        const mark =
          isRecent ? ['·', 'success']
          : isActive ? (a.status === 'waiting' ? ['◐', 'warning'] : ['●', 'success'])
          : a.status === 'failed' ? ['✗', 'error']
          : a.status === 'killed' ? ['■', 'inactive']
          : a.status === 'idle' ? ['○', 'inactive']
          : a.status === 'unlisted' ? ['·', 'inactive']
          : ['✓', 'inactive']
        const name = a.description || (a.status === 'unlisted' ? 'ohne Listeneintrag (Workflow oder intern)' : a.id)
        const state =
          a.status === 'unlisted' ? (isRecent ? 'aktiv' : 'ruht')
          : a.status === 'waiting' ? 'wartet'
          : a.status === 'pending' ? 'startet'
          : a.status === 'idle' ? 'wartet auf Nachricht'
          : a.status === 'failed' ? 'fehlgeschlagen'
          : a.status === 'killed' ? 'gestoppt'
          : isActive ? 'läuft'
          : 'fertig'
        const facts = [
          `${fmtUsd(a.usd)}${a.unpriced ? '+?' : ''}`,
          fmtRun((end ?? now) - a.startedAt),
          state,
          plural(a.calls, 'Aufruf', 'Aufrufe'),
          a.type || (a.model ? (modelKey(a.model) ?? a.model) : ''),
        ].filter(Boolean)
        const isBright = isActive || isRecent
        items.push({
          at: end ?? now,
          isActive,
          row: (
            <Box key={`a:${a.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Text color={mark[1]}>{`${mark[0]} `}</Text>
                <Text bold={isActive} dimColor={!isBright} wrap="truncate-end">
                  {name}
                </Text>
              </Box>
              <Box paddingLeft={2} flexDirection="row" flexWrap="wrap">
                {bar(gauge(a.usd, total, [[Infinity, isBright ? 'success' : 'inactive']], BG_CELLS))}
                <Text dimColor={!isBright}>{`  ${facts.join(' · ')}`}</Text>
              </Box>
            </Box>
          ),
        })
      }
      for (const sh of Object.values(b.shells)) {
        const isActive = sh.endedAt === undefined
        if (sh.endedAt !== undefined && now - sh.endedAt > BG_SHOWN_MS) continue
        items.push({
          at: sh.endedAt ?? now,
          isActive,
          row: (
            <Box key={`s:${sh.id}`} flexDirection="row">
              <Text color={isActive ? 'success' : 'inactive'}>{isActive ? '● ' : '✓ '}</Text>
              <Text bold={isActive} dimColor={!isActive} wrap="truncate-end">
                {`${sh.kind === 'shell' ? 'Shell' : sh.kind}: ${sh.description}`}
              </Text>
              <Text dimColor>{`  ${fmtRun((sh.endedAt ?? now) - sh.startedAt)} · ${isActive ? 'läuft' : 'fertig'}`}</Text>
            </Box>
          ),
        })
      }
      // Laufende zuerst, dann die zuletzt beendeten.
      items.sort((x, y) => Number(y.isActive) - Number(x.isActive) || y.at - x.at)
      const hidden = items.length - BG_ROWS
      // Abgleich: was der Mod gezählt hat gegen den API-Gegenwert der Engine im selben Zeitraum. Der Rest
      // sind Aufrufe der Engine ohne turn.step, vor allem der Vorschlag nach jedem Turn.
      const engineUsd = b.since && s.usd !== undefined ? s.usd - b.since.usd : undefined
      const restUsd = engineUsd === undefined ? undefined : Math.max(0, engineUsd - counted)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {label('Hintergrund')}
            {working.agents.length || working.shells.length ? (
              <Text color="warning">
                {s.running ? `läuft: ${busyText(working, ', ')}` : `Session wartet auf ${busyText(working, ', ')}`}
              </Text>
            ) : (
              <Text dimColor>nichts läuft</Text>
            )}
          </Box>
          {items.slice(0, BG_ROWS).map(item => item.row)}
          {hidden > 0 ? <Text dimColor>{`… und ${plural(hidden, 'weiterer', 'weitere')}`}</Text> : ''}
          {counted > 0 || b.main.calls ? (
            <Text dimColor>
              {`Agenten ${fmtUsd(agentsUsd)} · Haupt-Loop ${fmtUsd(b.main.usd)}${b.main.unpriced ? '+?' : ''}` +
                (restUsd === undefined
                  ? ''
                  : ` · Nebenaufrufe der Engine ${fmtUsd(restUsd)}` +
                    (b.suggestions ? ` (u. a. ${plural(b.suggestions, 'Vorschlag', 'Vorschläge')} nach dem Turn)` : '')) +
                (b.since ? ` · seit ${fmtWhen(b.since.at, now)}` : '') +
                (engineUsd === undefined ? '' : `, zusammen ${fmtUsd(engineUsd)} wie die Engine`)}
            </Text>
          ) : (
            ''
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {limitRows.length ? limitRows : <Text dimColor>Keine Limit-Angaben, erst nach dem ersten Call</Text>}
        <Box marginTop={1} flexDirection="column">
          {contextRow}
          <Box flexDirection="row">
            {label('Cache')}
            {cacheText}
          </Box>
          <Box flexDirection="row">
            {label('Pickup')}
            {s.pickup === null || s.pickup === undefined ? (
              <Text dimColor>unbekannt: keine Marke vom sessions-Mod</Text>
            ) : s.pickup.file ? (
              <Text>{`${s.pickup.phrase} → ${s.pickup.file.split(/[\\/]/).pop() ?? s.pickup.file}`}</Text>
            ) : s.pickup.phrase ? (
              <Text dimColor>{`keine Pickup-Datei: „${s.pickup.phrase}“ hat keine 🔑-Zeile in MEMORY.md`}</Text>
            ) : (
              <Text dimColor>keine Pickup-Datei (Session begann ohne Pickup-Phrase)</Text>
            )}
          </Box>
          {s.pickup?.file
            ? detail(
                s.running ? (
                  <Text dimColor>Sichern & neu starten: nach dem laufenden Turn</Text>
                ) : confirming ? (
                  <Box flexDirection="row">
                    <Button key="abbrechen" label="Abbrechen" onPress={() => update($, confirm, () => 0)} />
                    <Text> </Text>
                    <Button key="ja" label="Ja, sichern & neu starten" hotkey="j" onPress={() => confirmRestart($)} />
                  </Box>
                ) : (
                  <Button key="neustart" label="Sichern & neu starten" onPress={() => askRestart($)} />
                ),
              )
            : ''}
          {autoRows}
          <Box flexDirection="row">
            {label('Session')}
            <Text>
              {`seit ${fmtWhen(s.startedAt, s.at)}${s.usd === undefined ? '' : ` · API-Gegenwert $${s.usd.toFixed(2)}`}`}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {background}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{`Stand ${fmtWhen(s.at, s.at)} · /verbrauch schliesst`}</Text>
        </Box>
      </Box>
    )
  })
}
