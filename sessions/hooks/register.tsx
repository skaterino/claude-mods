import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Anchor, Overview, Restart, Session } from '../types'

const PANE = 'sessions'
// Im Abo läuft der Prompt-Cache eine Stunde nach der letzten Antwort ab; warm heisst hier: 5 Minuten Reserve.
const TTL_MS = 60 * 60_000
const WARM_MS = 55 * 60_000
const EVERY_MS = 20_000
// Kennwörter in der Nachricht an die anderen Sessions; die globale CLAUDE.md erklärt [PAUSE-SICHERN].
const SAVE_MARK = '[PAUSE-SICHERN]'
const RESTART_MARK = '[PAUSE-NEU]'
const ASK_OTHERS =
  'Mike macht Pause und hat /pause ausgelöst: Bitte jetzt den aktuellen Stand in die Datei schreiben, die deine Pickup-Phrase einliest ' +
  '(🔑-Zeile in MEMORY.md; steht unten als Zieldatei, wenn der Mod sie kennt), sonst ins zuständige Memory, wie beim MEMORY-HEARTBEAT.'
// Anfang jedes eigenen Sicherungs-Prompts: daran erkennt turn.start den Sicherungs-Turn.
const SELF_MARK = 'Pause: Schreib jetzt'
const ASK_SELF = `${SELF_MARK} den aktuellen Stand ins zuständige Memory, wie beim MEMORY-HEARTBEAT.`
const askSelfInto = (a: Anchor): string =>
  `${SELF_MARK} den aktuellen Stand in ${a.file}, die Datei, die „${a.phrase}“ einliest, wie beim MEMORY-HEARTBEAT.`
const target = (a: Anchor): string => `Zieldatei (liest „${a.phrase}“ ein): ${a.file}`
// /pause auto (Auto-Neustart aus dem verbrauch-Mod): eigene Marke, damit turn.start den Sicherungs-Turn bindet.
// Die Session schreibt dazu genau eine Zeile Auto-Weiter mit der Kennung dieser Sicherung; der Mod prüft sie,
// statt sich auf die Bitte zu verlassen. Die Kennung zeigt, dass die Zeile zu dieser Sicherung gehört, auch wenn
// sie sonst Wort für Wort einer älteren gleicht (die bliebe dann unverändert und wäre keine Nachweis-Zeile).
const AUTO_MARK = 'Pause (Auto-Neustart): Schreib jetzt'
const askAutoInto = (a: Anchor, token: string): string =>
  `${AUTO_MARK} den aktuellen Stand in ${a.file}, die Datei, die „${a.phrase}“ einliest, wie beim MEMORY-HEARTBEAT. ` +
  'Kurz, nur das Neue (Memory-Arbeitsprozess in der globalen CLAUDE.md). Schreib zusätzlich genau eine Zeile ' +
  `\`Auto-Weiter: ja — <nächster konkreter Schritt> [${token}]\` oder \`Auto-Weiter: nein — <Grund> [${token}]\`, ` +
  `mit der Kennung [${token}] dieser Sicherung am Ende. Steht schon eine Auto-Weiter-Zeile in der Datei, ersetz sie ` +
  'durch die neue, auch wenn sie sonst gleich bleibt, statt eine zweite anzuhängen. nein, wenn der nächste Schritt Mike ' +
  'braucht: etwas zeigen oder abnehmen lassen, eine Entscheidung aus dem Plan, Geld, Rechtliches, ein Prod-Deploy, ' +
  'oder wenn du ihm zuletzt eine Frage gestellt hast (dann die Frage mit in die Datei). Nichts nachfragen, nicht ' +
  'zurückschreiben, danach nichts weiter tun.'
// Was die frische Session nach dem Auto-Neustart hinter der Pickup-Phrase liest. Ohne '<': anchorOf überspringt solche Zeilen.
const AUTO_GO =
  'Auto-Neustart: Prüf den Stand wie üblich gegen git/Prod, dann mach den Schritt aus `Auto-Weiter: ja` und arbeite ' +
  'danach im Plan weiter. Die Halt-Liste gilt: Braucht ein Schritt Mike, hör dort auf und frag ihn.'
const AUTO_WAIT =
  'Auto-Neustart: Stand einlesen, prüfen, kurz berichten (inkl. Grund aus `Auto-Weiter: nein`), dann warten.'
const AUTO_UNCLEAR =
  'Auto-Neustart: Stand einlesen, prüfen, kurz berichten, dann warten. Die Sicherung hatte keine eindeutige ' +
  '`Auto-Weiter`-Zeile.'
// Eine Zeile, die mit Auto-Weiter: beginnt, auch als Listenpunkt, Überschrift, Zitat, fett oder in Backticks
// (`- **Auto-Weiter:** ja — …`, `**Auto-Weiter**: nein`). AUTO_LINE liest den Wert: ja oder nein, danach Leerraum,
// Zeilenende oder — – - : . , ; (nach schliessendem Markup); die Kennung am Ende (` [a7f3]`) stört das nicht. So
// zählen `ja|nein`, `ja/nein` und der zurückgeschriebene Auftrag (`Auto-Weiter: ja — <…> [a7f3]` oder …) nicht; eine
// Zeile mit ja und nein als Wörtern auch nicht (AUTO_JA/NEIN), eine mit Platzhalter `<…>` aus dem Auftrag auch nicht.
const AUTO_LABEL = /^(?:>\s*)?(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?[*_`]*\s*Auto-Weiter[*_`]*\s*:/iu
const AUTO_LINE =
  /^(?:>\s*)?(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?[*_`]*\s*Auto-Weiter[*_`]*\s*:\s*[*_`]*\s*(ja|nein)(?=[*_`]*(?:\s|$|[—–\-:.,;]))/iu
// Nur die Platzhalter aus dem Auftrag (<nächster konkreter Schritt>, <Grund>, <…>); ein einzelnes < wie in
// „Kontext < 200k“ oder JSX wie <Box> in einem echten Schritt zählt nicht.
const AUTO_PLACEHOLDER = /<(?:…|\.{3}|nächster[^<>\n]{0,40}|Grund)>/iu
const AUTO_JA = /(?<![\p{L}\p{N}])ja(?![\p{L}\p{N}])/iu
const AUTO_NEIN = /(?<![\p{L}\p{N}])nein(?![\p{L}\p{N}])/iu
// Kommt der Auftrag mitten in eine laufende Arbeit, darf das Sichern sie nicht abbrechen; wartete die Session
// auf Mike, soll sie danach nicht von selbst loslegen.
const RULES =
  'Kurz halten, nur das Neue (Memory-Arbeitsprozess in der globalen CLAUDE.md). Hat dieser Auftrag dich mitten ' +
  'in einer Arbeit unterbrochen, mach danach dort weiter; hast du auf Mike gewartet, tu danach nichts weiter. ' +
  'Nichts nachfragen und nicht zurückschreiben.'
// Was der Mod beim Empfänger dazuschreibt; er weiss, ob der Auftrag in einen laufenden Turn kam.
const MID_TURN = 'Du warst mitten in einer Arbeit: nach dem Sichern dort weitermachen, falls noch etwas offen ist.'
const IDLE = 'Du hast auf Mike gewartet: nach dem Sichern nichts weiter tun.'
const USAGE =
  'Aufruf: /pause (Stand sichern), /pause neu (sichern, danach frisch mit der Pickup-Phrase), ' +
  '/pause selbst (nur diese Session sichern und frisch starten), /pause auto (wie selbst, die Session ' +
  'arbeitet danach von selbst weiter, wenn sie Auto-Weiter: ja schreibt) oder /pause abbrechen (ein vorgemerkter ' +
  'Neustart dieser Session entfällt)'

const overview = atom({ plugin: 'sessions', key: 'overview' } as const, { at: 0, list: [], error: '' } as Overview)
// Wem /pause die Sicherung aufgetragen hat, je Session-ID mit Zeitpunkt.
const asked = atom({ plugin: 'sessions', key: 'asked' } as const, {} as Record<string, number>)
// Nach dem laufenden Turn frisch starten: /clear, dann die Pickup-Phrase ins Feld (bei /pause auto abgeschickt);
// nur wenn die Zieldatei in dieser Zeit von der Session geschrieben wurde. null heisst nichts tun.
const restart = atom({ plugin: 'sessions', key: 'restart' } as const, null as Restart | null)

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : n > 0 ? `${n}` : '–'

const fmtAgo = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 120) return `${min} Min.`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} Tagen`
}

const fmtClock = (at: number): string => {
  try {
    return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }).format(at)
  } catch {
    return new Date(at).toISOString().slice(11, 16)
  }
}

const isWarm = (s: Session, now: number): boolean =>
  s.status === 'busy' || (s.lastApiAt > 0 && now - s.lastApiAt < WARM_MS)

const cacheText = (s: Session, now: number): string => {
  if (s.status === 'busy') return 'arbeitet'
  if (!s.lastApiAt) return 'noch keine Antwort'
  const idle = now - s.lastApiAt
  return idle < WARM_MS ? `warm, noch ${Math.max(1, Math.round((TTL_MS - idle) / 60_000))} Min.` : `❄ kalt seit ${fmtAgo(idle)}`
}

// Nach /pause: sichert noch, bis die Session wieder ruht und seither geantwortet hat.
const pauseText = (s: Session, since: number | undefined): string =>
  since === undefined ? '' : s.status === 'idle' && s.lastApiAt > since ? ' · ✓ gesichert' : ' · ⏳ sichert …'

async function home($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!dir) throw new Error('HOME ist nicht gesetzt')
  return dir
}

// Liest die Sessions über liste.js; ein Fehler steht in der Übersicht statt falscher Daten.
async function refresh($: EngineInterface): Promise<Overview> {
  const at = await $.clock.now()
  let next: Overview
  try {
    const run = await $.process.run(['node', `${await home($)}/.claude/mods/sessions/liste.js`], { timeoutMs: 20_000 })
    next =
      run.exitCode === 0
        ? { at, list: JSON.parse(run.stdout) as Session[], error: '' }
        : { at, list: [], error: (run.stderr || run.stdout).trim().slice(0, 300) || `liste.js endete mit ${run.exitCode}` }
  } catch (err) {
    next = { at, list: [], error: String(err).slice(0, 300) }
  }
  await update($, overview, () => next)
  return next
}

const NONE: Anchor = { phrase: '', file: '' }
// Nach so langer Zeit ohne begonnenen Sicherungs-Turn darf /pause selbst neu vormerken.
// So lange vor dem Vormerken zählt ein /auto aus noch (Lücke zwischen Auslösen in verbrauch und Vormerken hier).
const ABORT_SLACK_MS = 5_000
const MIN_RE_ARM_MS = 60_000
// Vergleichsform einer Phrase: "Web shop pickup" und "webshop pickup" sind dieselbe.
const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/') === b.replace(/\\/g, '/')

// MEMORY.md dieser Session: aus dem Kontext, sonst nach dem Muster der Projektordner.
async function memoryIndex($: EngineInterface): Promise<string> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const hit = usage.context.breakdown?.memoryFiles.find(f => /[\\/]memory[\\/]MEMORY\.md$/.test(f.path))
    if (hit) return hit.path
  } catch {
    // Dann eben über den Projektordner.
  }
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await home($)}/.claude`
  return `${config}/projects/${(await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')}/memory/MEMORY.md`
}

// Pickup-Phrasen aus MEMORY.md: in einer 🔑-Zeile die Phrase gleich nach dem Schlüssel, dazu „(auch `…`)“.
// Gehört eine Phrase zu zwei Dateien, ist sie zweideutig (null) und startet nichts neu.
const anchorsIn = (index: string, dir: string): Map<string, Anchor | null> => {
  const out = new Map<string, Anchor | null>()
  for (const line of index.split('\n')) {
    const link = /^\s*-\s*\[[^\]]*\]\(([^)\s]+\.md)\)/.exec(line)
    if (!link?.[1] || link[1].includes('..') || !line.includes('🔑')) continue
    const file = `${dir}/${link[1]}`
    for (const m of line.matchAll(/🔑\s*(?:Magic-Word:\s*)?`([^`]+)`|\(auch\s+`([^`]+)`\)/g)) {
      const phrase = (m[1] ?? m[2] ?? '').trim()
      const key = norm(phrase)
      if (!key) continue
      const had = out.get(key)
      out.set(key, had === undefined || had?.file === file ? { phrase, file } : null)
    }
  }
  return out
}

// Womit diese Session begann und wohin sie deshalb sichert. Ohne Eintrag in MEMORY.md bleibt file leer;
// ohne Pickup-Phrase auch phrase.
async function anchorOf($: EngineInterface): Promise<Anchor> {
  let anchors = new Map<string, Anchor | null>()
  try {
    const index = await memoryIndex($)
    anchors = anchorsIn(await $.fs.read(index), index.replace(/[\\/]MEMORY\.md$/, ''))
  } catch {
    // Ohne MEMORY.md kennt der Mod keine Zieldatei.
  }
  const rows = await $.session.messages()
  for (const row of rows.slice(0, 15)) {
    if (row.role !== 'user' || row.text.includes('<')) continue
    const text = norm(row.text.slice(0, 120))
    // Der längste passende Schlüssel entscheidet; ist er zweideutig, gibt es keine Zieldatei.
    let best: Anchor | null | undefined
    let bestKey = ''
    for (const [key, a] of anchors) {
      if (key.length > bestKey.length && text.startsWith(key)) {
        best = a
        bestKey = key
      }
    }
    if (best) return best
    const hit = /^\s*(.{1,40}?\bpickup)\b/i.exec(row.text)
    if (hit?.[1]) return { phrase: hit[1], file: '' }
  }
  return NONE
}

async function readText($: EngineInterface, file: string): Promise<string> {
  try {
    return await $.fs.read(file)
  } catch {
    return ''
  }
}

// Kennung einer Sicherung für /pause auto: 4 Hex-Zeichen, zufällig (crypto gehört zu den Globals des Hooks-Moduls).
const newToken = (): string => {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  }
}

// Eine Kennung, die noch nirgends in der Zieldatei steht: sonst gälte eine stehengebliebene alte Zeile mit
// zufällig gleicher Kennung als neu geschrieben.
async function freshToken($: EngineInterface, file: string): Promise<string> {
  const text = (await readText($, file)).toLowerCase()
  for (let i = 0; i < 20; i++) {
    const token = newToken()
    if (!text.includes(`[${token}]`)) return token
  }
  return newToken()
}

// Merkt den Neustart vor; der nächste Turn ist der Sicherungs-Turn. token nur bei /pause auto: die Kennung, die
// in der Auto-Weiter-Zeile stehen muss.
async function arm($: EngineInterface, a: Anchor, token?: string): Promise<void> {
  const at = await $.clock.now()
  await update($, restart, () => ({ ...a, turn: '', at, proof: [], ...(token !== undefined ? { auto: true as const, token } : {}) }))
}

// Der vorgemerkte Neustart, falls einer läuft (auch gegen einen alten Wert aus einer früheren Version).
async function armed($: EngineInterface): Promise<Restart | undefined> {
  const r = await read($, restart)
  return r && typeof r === 'object' && typeof r.file === 'string' && r.file && typeof r.turn === 'string' && Array.isArray(r.proof)
    ? r
    : undefined
}

const linesOf = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean)

// Was die Sicherung für den Auto-Neustart sagt: genau eine Auto-Weiter-Zeile in der Datei, die trägt die Kennung
// dieser Sicherung ([token], gross oder klein) und sagt eindeutig ja oder nein. Ob sie zu den Nachweis-Zeilen gehört,
// zählt nicht: die Kennung kennt nur dieser Sicherungs-Auftrag. Sonst gilt 'unklar' (die Session wartet): keine,
// eine alte oder eine anders geschriebene Kennung, mehrere Zeilen, ein Platzhalter `<…>`, ja und nein zugleich.
const autoDecision = (text: string, token: string | undefined): 'ja' | 'nein' | 'unklar' => {
  const hits = linesOf(text).filter(l => AUTO_LABEL.test(l))
  const line = hits[0]
  if (typeof token !== 'string' || !token || hits.length !== 1 || line === undefined) return 'unklar'
  if (!line.toLowerCase().includes(`[${token.toLowerCase()}]`) || AUTO_PLACEHOLDER.test(line)) return 'unklar'
  const value = AUTO_LINE.exec(line)?.[1]?.toLowerCase()
  if (!value || (AUTO_JA.test(line) && AUTO_NEIN.test(line))) return 'unklar'
  return value === 'ja' ? 'ja' : 'nein'
}

// Wann der verbrauch-Mod den Auto-Neustart dieser Session zuletzt abbrach (/auto aus nach dem Auslösen); 0 nie.
// Eine Datei statt /pause abbrechen allein: $.command.run wartet, bis die Session ruht, also bis nach dem
// Sicherungs-Turn, und dann liefe das /clear schon.
async function autoStoppedAt($: EngineInterface): Promise<number> {
  try {
    const data = JSON.parse(await readText($, `${await home($)}/.claude/mod-daten/sessions/${await $.session.id()}.abbruch`)) as {
      at?: unknown
    } | null
    return typeof data?.at === 'number' ? data.at : 0
  } catch {
    return 0
  }
}

// Vor einem Werkzeug, das die Zieldatei schreiben könnte: ihr Inhalt, um danach zu sehen, was es änderte.
async function snapshot($: EngineInterface, hits: (r: Restart) => boolean): Promise<string | undefined> {
  try {
    const r = await armed($)
    return r && hits(r) ? await readText($, r.file) : undefined
  } catch {
    return undefined
  }
}

// Nach dem Werkzeug: die Zeilen, die es neu in die Zieldatei brachte, sind der Nachweis. Zeilen, die es
// entfernte, fallen aus dem Nachweis (die Session hat ihren eigenen Eintrag überarbeitet).
async function credit($: EngineInterface, before: string | undefined, ok: boolean): Promise<void> {
  if (before === undefined || !ok) return
  try {
    const r = await armed($)
    if (!r) return
    const after = linesOf(await readText($, r.file))
    const had = new Set(linesOf(before))
    const now = new Set(after)
    const added = after.filter(l => !had.has(l))
    if (!added.length && after.length === had.size) return
    await update($, restart, x =>
      x ? { ...x, proof: [...new Set([...x.proof.filter(l => now.has(l)), ...added])].slice(-50) } : x,
    )
  } catch {
    // Ohne Nachweis startet die Session nur nicht neu.
  }
}

// Nennt ein Bash-Befehl die Datei als eigenes Wort (nicht project_abc.md für abc.md)?
const namesFile = (command: string, file: string): boolean => {
  const name = baseName(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[\\s/'"=(])${name}(?=$|[\\s'");|&>])`).test(command)
}

// Marke für liste.js: diese Session hat den Mod und kann sich nach /pause neu selbst neu starten. Dazu ihre
// Pickup-Phrase und Zieldatei, sobald bekannt; der verbrauch-Mod zeigt sie an.
async function mark($: EngineInterface, anchor: Anchor = NONE): Promise<void> {
  try {
    const file = `${await home($)}/.claude/mod-daten/sessions/${await $.session.id()}.json`
    const id = await $.session.id()
    await $.fs.write(file, JSON.stringify({ at: await $.clock.now(), pickup: anchor.phrase, file: anchor.file }))
    if (id !== markedId) {
      // Neue Session-ID (/clear): ihr Stand beginnt von vorn.
      markedId = id
      tries = 0
    }
    marked = anchor.file
    markedPhrase = anchor.phrase
  } catch {
    // Ohne Marke zeigt die Übersicht nur "ohne Mod".
  }
}

// Die Zieldatei steht erst nach dem ersten Prompt fest: nach den ersten Haupt-Turns nachtragen, bis sie bekannt
// ist. Die Phrase steht am Anfang; wer sie nach drei Turns nicht hat, bekommt keine mehr.
async function markAnchor($: EngineInterface): Promise<void> {
  // Nach einem /clear von Hand läuft der Prozess unter neuer ID weiter, ohne session.start: dann neu anfangen.
  if ((await $.session.id()) !== markedId) await mark($)
  if (marked || tries >= 3) return
  // Ein leerer Verlauf (frische Session vor dem ersten Prompt) verbraucht keinen Versuch.
  const rows = await $.session.messages()
  if (!rows.some(r => r.role === 'user' && !r.text.includes('<'))) return
  tries++
  const anchor = await anchorOf($).catch(() => NONE)
  // Auch eine Phrase ohne 🔑-Zeile kommt in die Marke, damit das verbrauch-Fenster den Grund nennen kann.
  if (anchor.file || (anchor.phrase && anchor.phrase !== markedPhrase)) await mark($, anchor)
}

// Modulzustand: ein Reload setzt ihn zurück.
let active = false
// Zieldatei, die zuletzt in der Marke stand; '' noch keine.
let marked = ''
let markedPhrase = ''
// Für welche Session-ID die Marke gilt und wie oft die Zieldatei dort schon gesucht wurde.
let markedId = ''
let tries = 0
let ticker: { cancel: () => void } | undefined

function watch($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(EVERY_MS, () => {
    void refresh($)
  })
}

async function show($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Sessions' })
  watch($)
}

// /pause selbst (auch der Knopf im verbrauch-Fenster): nur diese Session sichert und startet frisch, mit
// demselben Nachweis wie /pause neu; keine andere Session wird angeschrieben. auto (/pause auto, der
// Auto-Neustart des verbrauch-Mods): Auftrag mit Auto-Weiter-Zeile, danach wird die Phrase abgeschickt.
async function saveSelf($: EngineInterface, auto = false): Promise<{ text: string }> {
  const anchor = await anchorOf($).catch(() => NONE)
  if (!anchor.file) {
    return {
      text: anchor.phrase
        ? `Kein Neustart: „${anchor.phrase}“ steht nicht als 🔑 in MEMORY.md, es gibt keine Pickup-Datei.`
        : 'Kein Neustart: Diese Session begann ohne Pickup-Phrase, es gibt keine Pickup-Datei.',
    }
  }
  // Eine laufende oder frische Vormerkung sperrt; eine liegengebliebene (Prompt verworfen, nie gestartet) nicht.
  const pending = await armed($)
  if (pending && (pending.turn || (await $.clock.now()) - pending.at < MIN_RE_ARM_MS)) {
    return { text: 'Läuft schon: diese Session sichert gerade und startet danach neu.' }
  }
  const token = auto ? await freshToken($, anchor.file) : undefined
  await arm($, anchor, token)
  const self = await $.session.id()
  const now = await $.clock.now()
  await update($, asked, m => ({ ...m, [self]: now }))
  const ask = token !== undefined ? askAutoInto(anchor, token) : `${askSelfInto(anchor)} ${RULES}\n${IDLE}`
  $.clock.after(200, () => {
    void $.prompt.submit({ text: ask, asUser: true }).catch(() => {
      void update($, restart, () => null).catch(() => undefined)
      $.ui.toast('Diese Session konnte ihre Sicherung nicht starten: bitte selbst „Stand ins Memory“ sagen.', { timeoutMs: 10_000 })
    })
  })
  return {
    text: auto
      ? `Auto-Neustart: Diese Session sichert ihren Stand in ${baseName(anchor.file)} und startet danach frisch mit „${anchor.phrase}“, sobald sie die Datei geschrieben hat; mit Auto-Weiter: ja arbeitet sie dann von selbst weiter.`
      : `Diese Session sichert ihren Stand in ${baseName(anchor.file)} und startet danach frisch mit „${anchor.phrase}“, sobald sie die Datei geschrieben hat.`,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    active = e.isInteractive
    await $.command.register({
      name: 'sessions',
      description: 'Übersicht aller laufenden Claude-Sessions: Thema, Kontext, Cache warm oder kalt',
    })
    await $.command.register({
      name: 'pause',
      description: 'Vor der Pause: warme Sessions schreiben ihren Stand ins Memory; „neu“ startet sie danach frisch',
      argumentHint: '[neu|selbst|auto|abbrechen]',
    })
    marked = ''
    markedPhrase = ''
    markedId = ''
    tries = 0
    if (active) {
      await mark($)
      // Nach --resume oder einem Reload steht die Pickup-Phrase schon im Verlauf.
      await markAnchor($)
    }
    return started
  })

  on('command.run', { command: 'sessions' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Übersicht geschlossen.' }
    }
    await refresh($)
    await show($)
    return { text: 'Übersicht der Sessions offen.' }
  })

  on('command.run', { command: 'pause' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'neu' && arg !== 'selbst' && arg !== 'auto' && arg !== 'abbrechen') return { text: USAGE }
    if (arg === 'abbrechen') {
      // Auch der verbrauch-Mod nach /auto aus. Was schon gesichert wird, bleibt gesichert; nur der Neustart entfällt.
      if (!(await armed($))) return { text: 'Kein Neustart vorgemerkt.' }
      await update($, restart, () => null)
      return { text: 'Neustart abgebrochen: diese Session startet nach dem Sichern nicht neu, der Kontext bleibt.' }
    }
    if (arg === 'selbst') return saveSelf($)
    if (arg === 'auto') return saveSelf($, true)
    const fresh = arg === 'neu'
    const { list, error } = await refresh($)
    if (error) return { text: `Sessions nicht lesbar: ${error}` }
    const now = await $.clock.now()
    const self = await $.session.id()
    const others = list.filter(s => s.sessionId !== self)
    // Kalte Sessions nicht wecken: dort kostet schon das Sichern den vollen Neuschreib des Kontexts.
    const warm = others.filter(s => isWarm(s, now))
    const cold = others.filter(s => !isWarm(s, now))
    const message = `${ASK_OTHERS} ${SAVE_MARK}${fresh ? ` ${RESTART_MARK}` : ''}\n${RULES}`
    const reached: Session[] = []
    const failed: string[] = []
    for (const s of warm) {
      try {
        const sent = await $.tool.call({ tool: 'SendMessage', to: s.name, summary: 'Pause: Stand ins Memory', message })
        if (sent.deny) failed.push(`${s.name} (${sent.deny})`)
        else if (sent.isError) failed.push(`${s.name} (${String(sent.text ?? 'Fehler').slice(0, 120)})`)
        else reached.push(s)
      } catch (err) {
        failed.push(`${s.name} (${String(err).slice(0, 120)})`)
      }
    }
    const anchor = await anchorOf($).catch(() => NONE)
    if (fresh && anchor.file) await arm($, anchor)
    await update($, asked, m => ({ ...m, [self]: now, ...Object.fromEntries(reached.map(s => [s.sessionId, now])) }))
    // Ein Befehl darf keinen Prompt abschicken, solange er läuft: erst danach, über einen kurzen Timer.
    $.clock.after(200, () => {
      // Die eigene Session ruht hier immer (/pause wartet, bis sie frei ist): danach nichts weiter tun, auch
      // nicht das wieder aufnehmen, was Mike eben mit Esc gestoppt hat.
      void $.prompt.submit({ text: `${anchor.file ? askSelfInto(anchor) : ASK_SELF} ${RULES}\n${IDLE}`, asUser: true }).catch(() => {
        $.ui.toast('Diese Session konnte ihre Sicherung nicht starten: bitte selbst „Stand ins Memory“ sagen.', { timeoutMs: 10_000 })
      })
    })
    await show($)

    const into = anchor.file ? ` in ${baseName(anchor.file)}` : ''
    const lines = [
      fresh && anchor.file
        ? `Diese Session sichert ihren Stand${into} und startet danach frisch mit „${anchor.phrase}“, sobald sie die Datei geschrieben hat.`
        : fresh && anchor.phrase
          ? `Diese Session sichert ihren Stand; „${anchor.phrase}“ steht nicht als 🔑 in MEMORY.md, darum startet sie nicht neu.`
          : fresh
            ? 'Diese Session sichert ihren Stand; ohne Pickup-Phrase am Anfang startet sie nicht neu.'
            : `Diese Session sichert ihren Stand${into}.`,
    ]
    if (reached.length) lines.push(`Ebenfalls gesichert: ${reached.map(s => s.name).join(', ')}.`)
    if (fresh) {
      const manual = reached.filter(s => !s.hasMod)
      if (manual.length) lines.push(`Ohne Mod, sichern nur und starten nicht neu: ${manual.map(s => s.name).join(', ')}.`)
    }
    if (cold.length) lines.push(`Übersprungen, Cache schon kalt: ${cold.map(s => s.name).join(', ')}.`)
    if (failed.length) lines.push(`Nicht erreicht: ${failed.join('; ')}.`)
    return { text: lines.join('\n') }
  })

  // Empfänger von /pause: bekommt seine Zieldatei genannt; bei „neu“ startet er nach dem Turn frisch,
  // aber nur, wenn er sie geschrieben hat.
  on('prompt.submit', async ($, e, next) => {
    // Mike schreibt (Tastatur oder Telefon), während ein Auto-Neustart vorgemerkt ist: er ist da, der Neustart
    // entfällt. Auch mitten im Sicherungs-Turn; der sichert dann nur.
    if (active && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')) {
      try {
        if ((await armed($))?.auto) {
          await update($, restart, () => null)
          $.ui.toast('Auto-Neustart abgebrochen: du hast geschrieben.', { timeoutMs: 10_000 })
        }
      } catch {
        // Dann läuft der Neustart wie vorgemerkt.
      }
    }
    const fromPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (!active || !fromPeer || !e.text.includes(SAVE_MARK)) return next(e)
    const anchor = await anchorOf($).catch(() => NONE)
    const how = e.turnId ? MID_TURN : IDLE
    if (!anchor.file) return next({ ...e, text: `${e.text}\n${how}` })
    if (e.text.includes(RESTART_MARK)) {
      // Mitten in einen laufenden Turn zugestellt: der arbeitet nach dem Sichern weiter, ein Neustart
      // an seinem Ende verlöre das. Dann nur sichern.
      if (e.turnId) $.ui.toast('/pause neu kam in einen laufenden Turn: diese Session sichert nur und startet nicht neu.', { timeoutMs: 10_000 })
      else await arm($, anchor)
    }
    return next({ ...e, text: `${e.text}\n${target(anchor)}\n${how}` })
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const r = await armed($)
      // Nur der Turn des Sicherungs-Prompts, nicht ein vorher eingereihter anderer.
      const isSave = r?.auto ? e.text.includes(AUTO_MARK) : e.text.includes(SELF_MARK) || e.text.includes(SAVE_MARK)
      if (r && !r.turn && isSave) {
        await update($, restart, x => (x ? { ...x, turn: e.turnId } : x))
      }
    } catch {
      // Ohne Bindung bleibt der Neustart aus.
    }
    return started
  })

  // Wer schreibt die Zieldatei? Nur was die Session selbst schreibt, zählt für den Neustart.
  // Bei allen drei zählt nur, was der Aufruf selbst an der Datei änderte: Lesen (cat, tail, grep) ändert nichts.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await snapshot($, r => samePath(e.file_path, r.file))
    const ran = await next(e)
    await credit($, before, ran.deny === undefined && ran.isError !== true)
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const before = await snapshot($, r => samePath(e.file_path, r.file))
    const ran = await next(e)
    await credit($, before, ran.deny === undefined && ran.isError !== true)
    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const before = await snapshot($, r => namesFile(e.command, r.file))
    const ran = await next(e)
    await credit($, before, ran.deny === undefined && ran.isError !== true)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!active || e.agentId) return done
    await markAnchor($)
    const r = await armed($)
    // Nur das Ende des Sicherungs-Turns zählt; ein früher endender Turn lässt den Auftrag stehen.
    if (!r || r.turn !== e.turnId) return done
    await update($, restart, () => null)
    if (e.reason !== 'answer') {
      $.ui.toast('Kein Neustart nach /pause: Der Sicherungs-Turn endete nicht sauber.', { timeoutMs: 10_000 })
      return done
    }
    // Nur neu starten, wenn der Stand nachweislich in der Datei steht, die die Pickup-Phrase einliest.
    const now = await readText($, r.file)
    if (!r.proof.length || !r.proof.every(p => now.includes(p))) {
      $.ui.toast(`Kein Neustart nach /pause: ${baseName(r.file)} wurde nicht geschrieben, der Kontext bleibt.`, {
        timeoutMs: 10_000,
      })
      return done
    }
    // /auto aus kam, nachdem dieser Auto-Neustart vorgemerkt war (oder knapp davor, solange verbrauch ihn schon
    // ausgelöst, sessions ihn aber noch nicht vorgemerkt hatte): kein /clear.
    if (r.auto && (await autoStoppedAt($)) >= r.at - ABORT_SLACK_MS) {
      $.ui.toast('Auto-Neustart abgebrochen (/auto aus): gesichert, aber kein Neustart, der Kontext bleibt.', { timeoutMs: 10_000 })
      return done
    }
    const phrase = r.phrase
    // Auto-Neustart: die Phrase wird abgeschickt, mit dem Auftrag je nach Auto-Weiter-Zeile. Auch bei nein oder
    // unklar startet die Session frisch: kommt Mike zurück, trifft er auf einen kleinen Kontext.
    const decision = r.auto ? autoDecision(now, r.token) : undefined
    if (decision === 'unklar') {
      $.ui.toast(`Auto-Neustart: ${baseName(r.file)} hat keine eindeutige Auto-Weiter-Zeile mit der Kennung dieser Sicherung, die frische Session wartet.`, {
        timeoutMs: 10_000,
      })
    }
    // Nicht abwarten: /clear läuft erst, wenn die Session ruht, und dieser Turn endet gerade.
    void (async () => {
      await $.command.run({ command: 'clear' })
      // Nur eine leere Marke: welche Phrase gilt, zeigt erst der erste echte Turn (Mike kann sie noch ändern).
      await mark($)
      if (decision === undefined) await $.prompt.fill({ text: phrase })
      else {
        const then = decision === 'ja' ? AUTO_GO : decision === 'nein' ? AUTO_WAIT : AUTO_UNCLEAR
        // /clear ist hier schon fertig (kein Befehl läuft mehr): der Prompt startet gleich einen Turn.
        await $.prompt.submit({ text: `${phrase}\n${then}`, asUser: true })
      }
    })().catch(() => {
      $.ui.toast('Neustart nach /pause hat nicht geklappt: bitte /clear von Hand.', { timeoutMs: 10_000 })
    })
    return done
  })

  // /clear von Hand: der Prozess läuft unter neuer ID weiter, ohne session.start. Kurz danach die Marke für
  // die neue ID schreiben, damit Übersicht und verbrauch-Fenster die Session gleich wieder kennen.
  on('session.end', async ($, e, next) => {
    const done = await next(e)
    if (active && e.reason === 'clear') {
      $.clock.after(300, () => {
        void markAnchor($).catch(() => undefined)
      })
    }
    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      ticker?.cancel()
      ticker = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { at, list, error } = await read($, overview)
    const pending = await read($, asked)
    const self = await $.session.id()
    if (error) return <Text color="error">{`Sessions nicht lesbar: ${error}`}</Text>
    if (!at) return <Text dimColor>Lese die Sessions …</Text>
    const warm = list.filter(s => isWarm(s, at)).length
    return (
      <Box flexDirection="column">
        <Text dimColor>{`${list.length} Sessions · ${warm} warm · Stand ${fmtClock(at)}`}</Text>
        {list.map(s => {
          const color = s.status === 'busy' ? 'success' : isWarm(s, at) ? 'warning' : 'subtle'
          return (
            <Box flexDirection="column">
              <Text> </Text>
              <Text bold={s.sessionId === self} color={color} wrap="truncate">
                {`${s.name}${s.sessionId === self ? ' (diese)' : ''} · ${cacheText(s, at)}`}
              </Text>
              <Text wrap="truncate">{`  ${s.topic || '–'}`}</Text>
              <Text dimColor wrap="truncate">
                {`  ${fmtTokens(s.context)} · ${s.version}${s.hasMod ? '' : ' · ohne Mod'}${pauseText(s, pending[s.sessionId])}`}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
