// Liest die laufenden Claude-Sessions dieses Rechners für den Mod "sessions" und gibt sie als JSON aus.
// Quellen: das Session-Register von Claude Code (~/.claude/sessions/*.json, NIE die *.key-Dateien daneben:
// das sind Messaging-Schlüssel), Anfang und Ende der Transkripte (Thema, letzte Antwort, Kontext) und
// die Prozessliste (läuft der Prozess noch). Liest Transkripte nur stückweise, sie werden schnell gross.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const claude = path.join(os.homedir(), '.claude')
const registry = path.join(claude, 'sessions')
const projects = path.join(claude, 'projects')
// Hier legt jede Session mit dem Mod beim Start eine Marke ab: so sieht die Übersicht, wer sich selbst neu starten kann.
const markers = path.join(claude, 'mod-daten', 'sessions')
const WEEK = 7 * 86_400_000

// Läuft der Prozess noch? Signal 0 prüft nur; EPERM heisst: läuft, gehört aber einem anderen Benutzer.
// Steht im Register procStart (Startzeit in UTC wie `ps -o lstart`), muss sie passen: sonst gehört die
// PID inzwischen einem anderen Prozess und das Register ist ein Überbleibsel.
function alive(pid, procStart) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  if (!procStart) return true
  try {
    const out = cp.execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    })
    return out.trim().replace(/\s+/g, ' ') === String(procStart).trim().replace(/\s+/g, ' ')
  } catch {
    return true
  }
}

function readPart(file, fromEnd, max) {
  const size = fs.statSync(file).size
  const n = Math.min(size, max)
  const buf = Buffer.alloc(n)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0)
  } finally {
    fs.closeSync(fd)
  }
  return buf.toString('utf8').split('\n')
}

// Letzte Antwort des Modells im Haupt-Loop: Zeitpunkt (die Cache-Uhr) und Kontextgrösse. Die Änderungszeit
// der Datei taugt dafür nicht, um Mitternacht schreibt jede Session einen Datumswechsel hinein.
function lastAnswer(file) {
  const lines = readPart(file, true, 1_000_000)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue
    try {
      const o = JSON.parse(lines[i])
      const u = o.message && o.message.usage
      if (!u || o.isSidechain) continue
      const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      return { at: Date.parse(o.timestamp) || 0, context }
    } catch {
      // Die erste Zeile eines Stücks ist meist angeschnitten.
    }
  }
  return { at: 0, context: 0 }
}

// Worum es geht: die Pickup-Phrase, sonst der Anfang des ersten eigenen Prompts. Eingefügtes zählt mit
// seinem Inhalt; Kurzantworten wie „1“ oder „ja“ und Einschübe der Engine (<system-reminder> …) nicht.
function topic(file) {
  for (const line of readPart(file, false, 400_000)) {
    if (!line.includes('"type":"user"')) continue
    try {
      const o = JSON.parse(line)
      if (o.isMeta || o.isSidechain) continue
      const c = o.message && o.message.content
      let text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(b => b.type === 'text') || {}).text : ''
      if (text && text.trimStart().startsWith('<pasted_content')) text = text.replace(/<[^>]+>/g, ' ')
      if (!text || text.trimStart().startsWith('<')) continue
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length < 5) continue
      const hit = /^(.{1,40}?\bpickup)\b/i.exec(flat)
      return { topic: hit ? hit[1] : flat.slice(0, 60), pickup: hit ? hit[1] : '' }
    } catch {
      // Angeschnittene Zeile am Ende des Stücks.
    }
  }
  return { topic: '', pickup: '' }
}

function pruneMarkers(alive) {
  if (!fs.existsSync(markers)) return
  const now = Date.now()
  for (const f of fs.readdirSync(markers)) {
    const id = f.replace(/\.json$/, '')
    const file = path.join(markers, f)
    if (!alive.has(id) && now - fs.statSync(file).mtimeMs > WEEK) fs.rmSync(file, { force: true })
  }
}

function main() {
  const scopes = fs.existsSync(projects) ? fs.readdirSync(projects) : []
  const list = []
  for (const f of fs.readdirSync(registry)) {
    if (!f.endsWith('.json')) continue
    let o
    try {
      o = JSON.parse(fs.readFileSync(path.join(registry, f), 'utf8'))
    } catch {
      continue
    }
    if (!alive(Number(o.pid), o.procStart)) continue
    const id = o.sessionId || ''
    const file = id && scopes.map(s => path.join(projects, s, `${id}.jsonl`)).find(p => fs.existsSync(p))
    const last = file ? lastAnswer(file) : { at: 0, context: 0 }
    const about = file ? topic(file) : { topic: '', pickup: '' }
    list.push({
      pid: o.pid,
      sessionId: id,
      name: o.name || `pid ${o.pid}`,
      kind: o.kind || '',
      status: o.status || '',
      version: o.version || '',
      cwd: o.cwd || '',
      startedAt: o.startedAt || 0,
      lastApiAt: last.at,
      context: last.context,
      topic: about.topic,
      pickup: about.pickup,
      hasMod: Boolean(id) && fs.existsSync(path.join(markers, `${id}.json`)),
    })
  }
  pruneMarkers(new Set(list.map(s => s.sessionId)))
  list.sort((a, b) => b.lastApiAt - a.lastApiAt)
  // Nur ASCII auf die Pipe: Umlaute als \u-Escapes, egal wie der Leser dekodiert.
  process.stdout.write(JSON.stringify(list).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
}

try {
  main()
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err))
  process.exitCode = 1
}
