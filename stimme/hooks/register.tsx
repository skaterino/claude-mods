import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StimmeStatus } from '../types'

// Vorlesen der Antworten mit lokalen Piper-Stimmen (Mikes eigene, Standard Danneberg; Notweg Windows-Stimme Karsten),
// Knöpfe im Verbrauch-Fenster,
// Diktieren per Win+H. Vorlesen an/aus gilt pro Session (sonst redeten alle parallelen Sessions durcheinander),
// das Tempo für alle.

const MAX_ZEICHEN = 6000
const TEMPO_STANDARD = 1.0 // 1.0 = natürliches Tempo der Stimme
const TEMPO_MIN = 0.6
const TEMPO_MAX = 2.5
/** Reihenfolge des Knopfs „Stimme“; Name = de_DE-<name>-medium.onnx in ~/.local/piper/voices, „karsten“ = Windows-Stimme. */
const STIMMEN = ['danneberg', 'robert', 'terrenceclean', 'terrence', 'karsten'] as const
const STIMME_STANDARD = 'danneberg'
const STIMME_TITEL: Record<string, string> = {
  danneberg: 'Danneberg',
  robert: 'Robert',
  terrenceclean: 'Terrence Clean',
  terrence: 'Terrence',
  karsten: 'Karsten',
}
const VERBRAUCH_PANE = 'verbrauch'

const an = atom({ plugin: 'stimme', key: 'an' } as const, false)
const tempo = atom({ plugin: 'stimme', key: 'tempo' } as const, TEMPO_STANDARD)
const status = atom({ plugin: 'stimme', key: 'status' } as const, 'still' as StimmeStatus)
const letzter = atom({ plugin: 'stimme', key: 'letzter' } as const, '')
const stimmeWahl = atom({ plugin: 'stimme', key: 'stimme' } as const, STIMME_STANDARD as string)
/** Gewähltes Ausgabegerät als "BUS|Name" (wie scripts/geraete.ps1 es liefert); '' = automatisch (BT > USB-Headset > Realtek). */
const geraetWahl = atom({ plugin: 'stimme', key: 'geraet' } as const, '')

/** Kurzer Name fürs Fenster: "Speakers (Realtek(R) Audio)" → "Realtek(R) Audio", Bildschirme nach ihrem Modell, BT markiert. */
export function geraetTitel(eintrag: string): string {
  if (!eintrag) return 'automatisch'
  const trenner = eintrag.indexOf('|')
  const bus = trenner >= 0 ? eintrag.slice(0, trenner) : ''
  const name = trenner >= 0 ? eintrag.slice(trenner + 1) : eintrag
  const m = /^(.*?) \((.*)\)$/.exec(name)
  let kurz = name
  if (m) kurz = /High Definition Audio Device/.test(m[2] ?? '') ? (m[1] ?? name).replace(/^\d+ - /, '') : (m[2] ?? name)
  if (bus === 'BTHENUM') return `${kurz} (BT)`
  if (bus === 'BTHHFENUM') return `${kurz} (BT Freisprech)`

  return kurz
}

function geraetName(eintrag: string): string {
  const trenner = eintrag.indexOf('|')

  return trenner >= 0 ? eintrag.slice(trenner + 1) : eintrag
}

/** Macht aus Markdown einen Text, der sich vorlesen lässt: ohne Code, Tabellen, Links, Pfade und Emojis. */
export function zumVorlesen(md: string): string {
  let t = md.replace(/\r/g, '')
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '\n')
  t = t.replace(/```[\s\S]*?```/g, '\n')
  t = t
    .split('\n')
    .filter(zeile => !/^\s*\|/.test(zeile))
    .join('\n')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/`([^`\n]*)`/g, (_m, code: string) =>
    /\\|\w\/\w|^[\w.-]+\.\w{1,5}$/.test(code) || code.length > 40 ? '' : code,
  )
  t = t.replace(/https?:\/\/\S+/g, '')
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  t = t.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  t = t.replace(/^\s*>\s?/gm, '')
  t = t.replace(/\*\*|__/g, '')
  t = t.replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|[.,;:!?]|$)/g, '$1$2')
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, '')
  t = t.replace(/\s*(?:→|->|⇒)\s*/g, ', ')
  t = t.replace(/[ \t]+/g, ' ')
  t = t
    .split('\n')
    .map(zeile => zeile.trim())
    .filter(zeile => zeile.length > 0)
    .map(zeile => (/[.!?:;,]$/.test(zeile) ? zeile : `${zeile}.`))
    .join('\n')
  if (t.length > MAX_ZEICHEN) {
    const schnitt = t.lastIndexOf('.', MAX_ZEICHEN)
    t = `${t.slice(0, schnitt > 0 ? schnitt + 1 : MAX_ZEICHEN)}\nDer Rest steht im Terminal.`
  }

  return t
}

type Laufend = { return?: (value?: never) => unknown }

let laufend: Laufend | undefined
let datenOrdner: string | undefined
let letzterTurn: string | undefined

async function daten($: EngineInterface) {
  if (!datenOrdner) {
    const env = await $.process.hookEnv()
    datenOrdner = env.CLAUDE_PLUGIN_DATA ?? `${$.plugin.root}\\daten`
  }

  return datenOrdner
}

function skript($: EngineInterface, name: string) {
  return `${$.plugin.root}\\scripts\\${name}`
}

async function steuern($: EngineInterface, befehl: '' | 'pause' | 'stopp') {
  await $.fs.write(`${await daten($)}\\steuerung.txt`, befehl)
}

async function stoppen($: EngineInterface) {
  const alt = laufend
  laufend = undefined
  try {
    void alt?.return?.()
  } catch {
    // Kind schon weg
  }
  await steuern($, 'stopp')
  await update($, status, () => 'still')
}

async function tempoSetzen($: EngineInterface, schritt: number) {
  const neu = await update($, tempo, alt => {
    const wert = Math.round(((alt ?? TEMPO_STANDARD) + schritt) * 10) / 10

    return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, wert))
  })
  const wert = typeof neu === 'number' ? neu : await read($, tempo)
  await $.store.set('tempo', wert)
  await $.fs.write(`${await daten($)}\\tempo.txt`, String(wert))
}

async function sprechen($: EngineInterface, text: string) {
  const alt = laufend
  laufend = undefined
  try {
    void alt?.return?.()
  } catch {
    // Kind schon weg
  }
  if (!text.trim()) return
  const ordner = await daten($)
  await $.fs.write(`${ordner}\\tempo.txt`, String(await read($, tempo)))
  await $.fs.write(`${ordner}\\stimme.txt`, await read($, stimmeWahl))
  await $.fs.write(`${ordner}\\geraet.txt`, geraetName(await read($, geraetWahl)))
  const kind = $.process.spawn({
    argv: [
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      skript($, 'sprechen.ps1'),
      '-Daten',
      ordner,
    ],
    input: text,
  })
  const ich = kind as unknown as Laufend
  laufend = ich
  await update($, status, () => 'spricht')
  void (async () => {
    try {
      for await (const stueck of kind) {
        if (stueck.stream === 'stderr') $.ui.log(`stimme: ${stueck.text}`, { to: 'debug' })
      }
    } catch (fehler) {
      $.ui.log(`stimme: Vorlesen fehlgeschlagen: ${String(fehler)}`, { to: 'debug' })
    } finally {
      if (laufend === ich) {
        laufend = undefined
        await update($, status, () => 'still')
      }
    }
  })()
}

async function stimmeWechseln($: EngineInterface, name?: string) {
  const jetzt = await read($, stimmeWahl)
  const i = STIMMEN.indexOf(jetzt as (typeof STIMMEN)[number])
  const neu = name ?? STIMMEN[(i + 1) % STIMMEN.length] ?? STIMME_STANDARD
  await update($, stimmeWahl, () => neu)
  await $.store.set('stimme', neu)
  await $.fs.write(`${await daten($)}\\stimme.txt`, neu)

  return neu
}

/** Schaltet reihum: automatisch → jedes aktive Ausgabegerät → automatisch. */
async function ausgabeWechseln($: EngineInterface) {
  const r = await $.process.run(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', skript($, 'geraete.ps1')],
    { timeoutMs: 15_000 },
  )
  const geraete = r.stdout
    .split(/\r?\n/)
    .map(z => z.trim())
    .filter(z => z.includes('|'))
  const wahl = ['', ...geraete]
  const jetzt = await read($, geraetWahl)
  const i = wahl.indexOf(jetzt)
  const neu = wahl[(i + 1) % wahl.length] ?? ''
  await update($, geraetWahl, () => neu)
  await $.store.set('geraet', neu)
  await $.fs.write(`${await daten($)}\\geraet.txt`, geraetName(neu))

  return neu
}

async function pauseUmschalten($: EngineInterface) {
  const jetzt = await read($, status)
  if (jetzt === 'spricht') {
    await steuern($, 'pause')
    await update($, status, () => 'pausiert')
  } else if (jetzt === 'pausiert') {
    await steuern($, '')
    await update($, status, () => 'spricht')
  }
}

async function vorlesenUmschalten($: EngineInterface, wunsch?: boolean) {
  const neu = wunsch ?? !(await read($, an))
  await update($, an, () => neu)
  if (!neu) await stoppen($)

  return neu
}

async function diktieren($: EngineInterface, mitWinH: boolean) {
  const args = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', skript($, 'diktat.ps1')]
  const r = await $.process.run(mitWinH ? [...args, '-WinH'] : args, { timeoutMs: 20_000 })
  const zahl = r.stdout.trim().split(/\r?\n/).pop() ?? ''
  if (r.exitCode !== 0 || !/^\d+\/\d+$/.test(zahl)) {
    return `Umstellen hat nicht geklappt: ${(r.stderr || r.stdout).trim().slice(0, 300)}`
  }

  return `Terminal-Fenster auf Deutsch (Deutschland) gestellt (${zahl}).`
}

/** Alle Texte der Antworten seit dem letzten Prompt, in Reihenfolge; ersatzweise der Schlusstext. */
async function textSeitLetztemPrompt($: EngineInterface, schluss: string) {
  const zeilen = await $.session.messages({ last: 400 })
  if (!Array.isArray(zeilen)) return schluss
  const teile: string[] = []
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const m = zeilen[i]
    if (!m) continue
    if (m.role === 'user') {
      const istPrompt = !(m.toolResults && m.toolResults.length > 0) && m.text.trim().length > 0
      if (istPrompt) break
      continue
    }
    if (m.text.trim()) teile.unshift(m.text)
  }
  if (teile.length === 0) return schluss
  if (schluss.trim() && !(teile[teile.length - 1] ?? '').includes(schluss.trim().slice(0, 80))) teile.push(schluss)

  return teile.join('\n\n')
}

/** Die zuletzt vorgelesene Antwort; fehlt sie (z. B. Vorlesen war aus), die Antwort seit dem letzten Prompt. */
async function letzteAntwort($: EngineInterface) {
  const gemerkt = await read($, letzter)
  if (gemerkt) return gemerkt

  return zumVorlesen(await textSeitLetztemPrompt($, ''))
}

/** Der Mod braucht Windows (PowerShell, winmm, WinRT); auf dem Mac bleibt er still. */
function aufWindows($: EngineInterface) {
  return /^[A-Za-z]:[\\/]/.test($.plugin.root)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!aufWindows($)) return next(e)
    await $.command.register({
      name: 'vorlesen',
      description: 'Antworten vorlesen: /vorlesen an | aus | stopp | pause | nochmal | stimme [name] | ausgabe | test',
    })
    await $.command.register({
      name: 'diktat',
      description: 'Terminal auf Deutsch (Deutschland) stellen, damit Win+H diktiert',
    })
    // Mit Piper heisst Tempo 1.0 „natürlich“; das alte Karsten-Tempo (Standard 1.4) einmalig zurücksetzen
    if ((await $.store.get('tempoSkala')) !== 'piper') {
      await $.store.set('tempo', TEMPO_STANDARD)
      await $.store.set('tempoSkala', 'piper')
    }
    const gespeichert = await $.store.get('tempo')
    if (typeof gespeichert === 'number') await update($, tempo, () => gespeichert)
    const stimme = await $.store.get('stimme')
    if (typeof stimme === 'string' && stimme) await update($, stimmeWahl, () => stimme)
    const geraet = await $.store.get('geraet')
    if (typeof geraet === 'string') await update($, geraetWahl, () => geraet)

    return next(e)
  })

  on('command.run', { command: 'vorlesen' }, async ($, e) => {
    const wunsch = e.args.trim().toLowerCase()
    if (wunsch === 'an' || wunsch === 'ein') {
      await vorlesenUmschalten($, true)
      return { text: 'Vorlesen ist an (nur diese Session). Ein neuer Prompt stoppt die Stimme.' }
    }
    if (wunsch === 'aus') {
      await vorlesenUmschalten($, false)
      return { text: 'Vorlesen ist aus.' }
    }
    if (wunsch === 'stopp' || wunsch === 'stop') {
      await stoppen($)
      return { text: 'Stimme gestoppt.' }
    }
    if (wunsch === 'pause' || wunsch === 'weiter') {
      await pauseUmschalten($)
      return { text: `Stimme ${(await read($, status)) === 'pausiert' ? 'pausiert' : 'läuft weiter'}.` }
    }
    if (wunsch.startsWith('stimme')) {
      const name = wunsch.slice(6).trim()
      if (name && !STIMMEN.includes(name as (typeof STIMMEN)[number])) {
        return { text: `Unbekannte Stimme. Zur Wahl: ${STIMMEN.join(', ')}` }
      }
      const neu = await stimmeWechseln($, name || undefined)
      return { text: `Stimme: ${STIMME_TITEL[neu] ?? neu}.` }
    }
    if (wunsch === 'ausgabe') {
      const neu = await ausgabeWechseln($)
      return { text: `Ausgabe: ${geraetTitel(neu)}.` }
    }
    if (wunsch === 'nochmal') {
      const text = await letzteAntwort($)
      if (!text) return { text: 'Es gibt noch nichts zum Wiederholen.' }
      await sprechen($, text)
      return { text: 'Letzte Antwort wird nochmal vorgelesen.' }
    }
    if (wunsch === 'test') {
      await sprechen($, 'Hallo Mike. So klingt das Vorlesen. Mit Plus und Minus im Verbrauch-Fenster stellst du das Tempo ein, mit dem Knopf Stimme wechselst du die Stimme.')
      return { text: 'Testsatz wird gesprochen.' }
    }
    const istAn = await read($, an)
    return { text: `Vorlesen ist ${istAn ? 'an' : 'aus'}, Tempo ${(await read($, tempo)).toFixed(1)}. Befehle: /vorlesen an | aus | stopp | pause | nochmal | stimme [name] | ausgabe | test` }
  })

  on('command.run', { command: 'diktat' }, async $ => {
    return { text: `${await diktieren($, false)} Jetzt mit Win+H diktieren.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (laufend) await stoppen($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ergebnis = await next(e)
    if (e.agentId || e.reason !== 'answer' || !aufWindows($)) return ergebnis
    if (!(await read($, an))) return ergebnis
    // Pro Turn nur einmal, und denselben Text nicht neu starten, solange er noch läuft
    // (Nebenaufrufe der Engine nach dem Turn lösten sonst mehrere Starts aus, die sich gegenseitig abbrachen).
    if (e.turnId === letzterTurn) return ergebnis
    letzterTurn = e.turnId
    const text = zumVorlesen(await textSeitLetztemPrompt($, e.answer))
    if (text === (await read($, letzter)) && (await read($, status)) !== 'still') return ergebnis
    await update($, letzter, () => text)
    await sprechen($, text)

    return ergebnis
  })

  // Knopfzeile oben im Verbrauch-Fenster; das Fenster selbst zeichnet der Mod "verbrauch" darunter.
  // Ohne `plugin` hört ein ui.render-Hook nur auf die eigenen Fenster; das Verbrauch-Fenster gehört dem Mod "verbrauch".
  on('ui.render', { plugin: 'verbrauch', component: 'Pane', requestId: VERBRAUCH_PANE }, async ($, e, next) => {
    const innen = await next(e)
    if (!aufWindows($)) return innen
    const { Box, Button, Text } = $.ui.resolve(e)
    const istAn = await read($, an)
    const jetzt = await read($, status)
    const t = await read($, tempo)
    const stimmeJetzt = await read($, stimmeWahl)
    const geraetJetzt = await read($, geraetWahl)
    const laeuft = jetzt !== 'still'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={10} flexShrink={0}>
            <Text bold>Stimme</Text>
          </Box>
          <Button
            key="stimme-vorlesen"
            label={istAn ? 'Vorlesen: an' : 'Vorlesen: aus'}
            variant={istAn ? 'primary' : undefined}
            onPress={() => vorlesenUmschalten($)}
          />
          <Button
            key="stimme-pause"
            label={jetzt === 'pausiert' ? 'Weiter' : 'Pause'}
            onPress={() => pauseUmschalten($)}
          />
          <Button key="stimme-stopp" label="Stopp" onPress={() => stoppen($)} />
          <Button
            key="stimme-nochmal"
            label="Nochmal"
            onPress={async () => {
              const text = await letzteAntwort($)
              if (text) await sprechen($, text)
              else $.ui.toast('Es gibt noch nichts zum Wiederholen.')
            }}
          />
          <Button
            key="stimme-diktat"
            label="Diktieren"
            onPress={async () => {
              const meldung = await diktieren($, true)
              if (meldung.startsWith('Umstellen')) $.ui.toast(meldung)
            }}
          />
        </Box>
        <Box flexDirection="row" flexWrap="wrap">
          <Box width={10} flexShrink={0}>
            <Text dimColor>{laeuft ? (jetzt === 'pausiert' ? 'pausiert' : 'spricht') : ''}</Text>
          </Box>
          <Text>{`Tempo ${t.toFixed(1)}× `}</Text>
          <Button key="stimme-langsamer" label="−" onPress={() => tempoSetzen($, -0.1)} />
          <Button key="stimme-schneller" label="+" onPress={() => tempoSetzen($, 0.1)} />
          <Text> </Text>
          <Button
            key="stimme-wahl"
            label={`Stimme: ${STIMME_TITEL[stimmeJetzt] ?? stimmeJetzt}`}
            onPress={() => stimmeWechseln($)}
          />
          <Button
            key="stimme-ausgabe"
            label={`Ausgabe: ${geraetTitel(geraetJetzt)}`}
            onPress={() => ausgabeWechseln($)}
          />
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(10, Math.min(60, e.props.bodyColumns)))}</Text>
        {innen}
      </Box>
    )
  })
}
