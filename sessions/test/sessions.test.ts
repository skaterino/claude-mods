import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const HOUR = 60 * MIN
const lastOf = (list: string[]): string | undefined => list[list.length - 1]
const NOW = Date.parse('2026-10-13T08:00:00Z')
const START = { cwd: 'C:/test', surface: 'terminal', isInteractive: true } as const
const SAVE_TURN = { text: 'Pause: Schreib jetzt den aktuellen Stand …', turnId: 't1' } as const
const PEER_TURN = { text: 'Mike macht Pause … [PAUSE-SICHERN] [PAUSE-NEU]\nZieldatei …', turnId: 't1' } as const
const TURN = { answer: 'gesichert', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const PRESENTATION = { isFullscreen: true, columns: 200 } as const
const typed = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: PRESENTATION }) as const

const session = (name: string, sessionId: string, status: string, idleMin: number, extra = {}) => ({
  pid: 1,
  sessionId,
  name,
  kind: 'interactive',
  status,
  version: '2.1.296',
  cwd: 'C:\\Users\\test',
  startedAt: NOW - 600 * MIN,
  lastApiAt: NOW - idleMin * MIN,
  context: 400_000,
  topic: `${name} pickup`,
  pickup: `${name} pickup`,
  hasMod: false,
  ...extra,
})

const LIST = [
  session('che0ftm-27', 's-self', 'busy', 0, { hasMod: true }),
  session('che0ftm-e0', 's-e0', 'idle', 38),
  session('client Portal', 's-portal', 'idle', 68),
  session('che0ftm-af', 's-af', 'idle', 3 * 24 * 60),
]

const MEM = '/home/mike/.claude/projects/-home-mike/memory'
const INDEX = [
  '- [User profile](user_mike.md) — Mikes Rolle',
  '- [Mods — Pickup-Anker](mods.md) — **🔑 `mods pickup`** → Einstieg zu den Mods',
  '- [Webshop-UI](project_webshop_ui.md) — 🔑 `webshop pickup`: Kundenbereich, siehe auch `kunde pickup`',
  '- [Kunde](session_resume.md) — **PRIMARY SoT**, **🔑 `kunde pickup`**. Älteres in `history.md`',
  '- [Tobi](tobi_application.md) — **🔑 `pickup tobi application`** (auch `tobi pickup`) → ERP',
  '- [Abandoned](session_resume_abandoned.md) — **🔑 Magic-Word: `abandoned resume`** → liest Kontext',
  '- [Onboarding-Kit](reference_onboarding_kit.md) — 🔑 bei ausgefülltem Formular: `ingest_form.py` auslesen',
].join('\n')

// Steht unter dem Plugin für die Engine und sammelt, was der Mod auslöst. Was der Mod selbst beantwortet
// (seine Befehle /pause und /sessions), kommt hier nicht an, nur was er weitergibt (/clear).
const engine = (on: On, rows = [{ role: 'user', text: 'mods pickup', toolUses: [] }], memoryFiles = [`${MEM}/MEMORY.md`]) => {
  let tick = 0
  const seen = {
    clock: mock.clock(on, { now: NOW }),
    sent: [] as { to: string; message: string }[],
    prompts: [] as string[],
    commands: [] as string[],
    fills: [] as string[],
    opened: [] as string[],
    toasts: [] as string[],
    // Dateien mit Inhalt und mtime; ein Edit der Session setzt die mtime auf die Uhrzeit.
    files: new Map<string, { text: string; mtimeMs: number }>([
      [`${MEM}/MEMORY.md`, { text: INDEX, mtimeMs: NOW - 600 * MIN }],
      [`${MEM}/mods.md`, { text: 'Stand alt', mtimeMs: NOW - 60 * MIN }],
    ]),
    // Was das Modell im Sicherungs-Turn als Prompt bekam.
    edits: [] as string[],
    // Was der Mod per $.fs.write schrieb (die Marke).
    writes: new Map<string, string>(),
    // Die Session-ID; ein /clear von Hand gibt eine neue.
    id: 's-self',
  }
  mock.env(on, { HOME: '/home/mike', USERPROFILE: 'C:\\Users\\test' })
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 600 * MIN,
      context: {
        tokens: 400_000,
        window: 1_000_000,
        breakdown: { memoryFiles: memoryFiles.map(path => ({ path, type: 'AutoMem', tokens: 900 })) },
      },
      rateLimits: [],
    },
  }))
  on('fs.read', ($, e) => {
    const f = seen.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: f.text }
  })
  on('fs.stat', ($, e) => {
    const f = seen.files.get(e.path)
    if (!f) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(LIST), stderr: '' } }))
  on('session.id', () => ({ value: seen.id }))
  on('session.messages', () => ({ value: rows }))
  on('fs.write', ($, e) => {
    seen.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; to: string; message: string; file_path: string; command: string }
    const edit = e as unknown as { new_string?: string; content?: string }
    // Ein Edit mit "FAIL" scheitert wie "File has been modified since read" und ändert nichts.
    if (call.tool === 'Edit' && edit.new_string?.startsWith('FAIL')) return { result: 'File has been modified since read', isError: true, text: 'File has been modified since read' }
    if (call.tool === 'Edit' || call.tool === 'Write') {
      const old = seen.files.get(call.file_path)?.text ?? ''
      const text = call.tool === 'Write' ? (edit.content ?? '') : `${old}\n${edit.new_string ?? ''}`
      seen.files.set(call.file_path, { text, mtimeMs: NOW + ++tick * 1_000 })
      seen.edits.push(call.file_path)
      return { result: { success: true } }
    }
    if (call.tool === 'Bash') {
      // ">> datei" hängt eine Zeile an; alles andere liest nur.
      const hit = />> (\S+)/.exec(call.command)
      const file = hit?.[1]
      if (file) {
        const old = seen.files.get(file)?.text ?? ''
        seen.files.set(file, { text: `${old}\nStand per Bash ${++tick}`, mtimeMs: NOW + tick * 1_000 })
      }
      return { result: { stdout: '' } }
    }
    seen.sent.push({ to: call.to, message: call.message })
    return { result: { success: true } }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return seen
}

test('/pause schickt nur warmen Sessions die Sicherung und sichert diese Session selbst', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)

  const answer = await $.command.run(typed('pause'))
  expect(seen.sent.map(s => s.to)).toEqual(['che0ftm-e0'])
  expect(seen.sent[0].message).toMatch(/^Mike macht Pause und hat \/pause ausgelöst: .+ \[PAUSE-SICHERN\]\n/)
  expect(seen.sent[0].message).not.toMatch(/PAUSE-NEU/)
  expect(seen.sent[0].message).toMatch(/die deine Pickup-Phrase einliest/)
  // Eine Session mitten in der Arbeit sichert und macht dann weiter, statt abzubrechen.
  expect(seen.sent[0].message).toMatch(/\nKurz halten, nur das Neue .+ Hat dieser Auftrag dich mitten in einer Arbeit unterbrochen, mach danach dort weiter; hast du auf Mike gewartet, tu danach nichts weiter\./)
  expect(answer.text).toMatch(/^Diese Session sichert ihren Stand in mods\.md\.\nEbenfalls gesichert: che0ftm-e0\./)
  expect(answer.text).toMatch(/Übersprungen, Cache schon kalt: client Portal, che0ftm-af\.$/)
  expect(seen.opened).toEqual(['sessions'])

  // Der eigene Sicherungs-Prompt folgt kurz nach dem Befehl.
  expect(seen.prompts).toEqual([])
  await seen.clock.advance(300)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/^Pause: Schreib jetzt den aktuellen Stand in \/home\/mike\/.+\/memory\/mods\.md, die Datei, die „mods pickup“ einliest/)
  expect(seen.prompts[0]).toMatch(/\nDu hast auf Mike gewartet: nach dem Sichern nichts weiter tun\.$/)
  // Ohne "neu" bleibt die Session, wie sie ist.
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('/pause neu startet diese Session nach dem Sicherungs-Turn frisch mit der Pickup-Phrase', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)

  const answer = await $.command.run(typed('pause', 'neu'))
  expect(seen.sent[0].message).toMatch(/\[PAUSE-SICHERN\] \[PAUSE-NEU\]\n/)
  expect(answer.text).toMatch(/^Diese Session sichert ihren Stand in mods\.md und startet danach frisch mit „mods pickup“, sobald sie die Datei geschrieben hat\./)
  expect(answer.text).toMatch(/Ohne Mod, sichern nur und starten nicht neu: che0ftm-e0\./)

  await seen.clock.advance(300)
  expect(seen.prompts.length).toBe(1)
  // Der Sicherungs-Turn beginnt, das Modell sichert in die Zieldatei.
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause 10:00: F0 fertig, F1 offen' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.fills).toEqual(['mods pickup'])
})

test('Eine Session mit dem Mod startet nach [PAUSE-NEU] einer anderen Session frisch', async ($, on) => {
  // Mike tippte die Phrase anders als MEMORY.md sie schreibt: zählt trotzdem.
  const seen = engine(on, [{ role: 'user', text: 'Web shop pickup', toolUses: [] }])
  seen.files.set(`${MEM}/project_webshop_ui.md`, { text: 'alt', mtimeMs: NOW - HOUR })
  await $.session.start(START)

  const note = { text: 'Mike macht Pause … [PAUSE-SICHERN] [PAUSE-NEU]', wait: false, origin: { kind: 'peer-send-message' } } as const
  await $.prompt.submit(note)
  // Das Modell bekommt seine Zieldatei genannt.
  expect(lastOf(seen.prompts)).toBe(
    `Mike macht Pause … [PAUSE-SICHERN] [PAUSE-NEU]\nZieldatei (liest „webshop pickup“ ein): ${MEM}/project_webshop_ui.md\nDu hast auf Mike gewartet: nach dem Sichern nichts weiter tun.`,
  )
  await $.turn.start(PEER_TURN)
  // Lesen zählt nicht, Anhängen per Bash schon.
  await $.tool.call({ tool: 'Bash', command: `tail -5 ${MEM}/project_webshop_ui.md` })
  await $.tool.call({ tool: 'Bash', command: `echo neu >> ${MEM}/project_webshop_ui.md` })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.fills).toEqual(['webshop pickup'])
})

test('Ohne Pickup-Phrase kein Neustart, falsche Argumente zeigen die Hilfe', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'prüfe bitte die Jiras', toolUses: [] }])
  await $.session.start(START)

  expect((await $.command.run(typed('pause', 'jetzt'))).text).toMatch(/^Aufruf: \/pause/)
  expect(seen.sent).toEqual([])
  const answer = await $.command.run(typed('pause', 'neu'))
  expect(answer.text).toMatch(/^Diese Session sichert ihren Stand; ohne Pickup-Phrase am Anfang startet sie nicht neu\./)
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('Ein abgebrochener Sicherungs-Turn startet nicht neu', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)

  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' })
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toMatch(/^Kein Neustart nach \/pause/)
})

test('/sessions öffnet die Übersicht', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)

  expect((await $.command.run(typed('sessions'))).text).toBe('Übersicht der Sessions offen.')
  expect(seen.opened).toEqual(['sessions'])
})

test('Kein Neustart, wenn die Session die Zieldatei nicht geschrieben hat: der Kontext bleibt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await seen.clock.advance(300)
  await $.turn.start(SAVE_TURN)
  // Das Modell schreibt woanders hin.
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/session_resume.md`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts).toEqual(['Kein Neustart nach /pause: mods.md wurde nicht geschrieben, der Kontext bleibt.'])
})

test('Kein Neustart, wenn die Session nur liest und eine andere Session schreibt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Bash', command: `tail -5 ${MEM}/mods.md && grep -c Stand ${MEM}/mods.md` })
  seen.files.set(`${MEM}/mods.md`, { text: 'von nebenan', mtimeMs: NOW + HOUR })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts).toEqual(['Kein Neustart nach /pause: mods.md wurde nicht geschrieben, der Kontext bleibt.'])
})

test('Kein Neustart, wenn eine andere Session den eigenen Eintrag danach überschreibt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause 10:00: eigener Stand' })
  seen.files.set(`${MEM}/mods.md`, { text: 'neu geschrieben von nebenan', mtimeMs: NOW + HOUR })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts.length).toBe(1)
})

test('Bash zählt nur die genannte Datei: project_abc.md ist nicht abc.md', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'abc pickup', toolUses: [] }])
  seen.files.set(`${MEM}/MEMORY.md`, { text: `${INDEX}\n- [ABC](abc.md) — **🔑 Magic-Word: \`abc pickup\`**`, mtimeMs: 0 })
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Bash', command: `echo x >> ${MEM}/project_abc.md` })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('Ein früher endender Turn verbraucht den Auftrag nicht; ein fehlgeschlagener Edit zählt nicht', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  // Ein Turn ohne Bindung endet: nichts passiert, der Auftrag bleibt.
  await $.turn.complete({ ...TURN, turnId: 't0' })
  expect(seen.toasts).toEqual([])
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'FAIL Pause: neu' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts.length).toBe(1)
})

test('In einen laufenden Turn zugestellt: sichert mit Zieldatei, startet aber nicht neu', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.turn.start(SAVE_TURN)
  const note = { text: 'Mike macht Pause … [PAUSE-SICHERN] [PAUSE-NEU]', wait: false, turnId: 't1', origin: { kind: 'peer-send-message' } } as const
  await $.prompt.submit(note)
  expect(lastOf(seen.prompts)).toMatch(/\nZieldatei \(liest „mods pickup“ ein\): .+\/mods\.md\nDu warst mitten in einer Arbeit: nach dem Sichern dort weitermachen, falls noch etwas offen ist\.$/)
  expect(seen.toasts[0]).toMatch(/^\/pause neu kam in einen laufenden Turn/)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: neu' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('Nur [PAUSE-SICHERN]: Zieldatei genannt, kein Neustart vorgemerkt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.prompt.submit({ text: 'Mike macht Pause … [PAUSE-SICHERN]', wait: false, origin: { kind: 'peer-send-message' } })
  expect(lastOf(seen.prompts)).toMatch(/\nZieldatei \(liest „mods pickup“ ein\): .+\/mods\.md\nDu hast auf Mike gewartet: nach dem Sichern nichts weiter tun\.$/)
  await $.turn.start(PEER_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: neu' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('notes pickup und my-notes pickup bleiben getrennt, eine zweideutige Phrase startet nicht neu', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'my-notes pickup', toolUses: [] }])
  seen.files.set(`${MEM}/MEMORY.md`, {
    text: [
      '- [Notes](project_notes.md) — **🔑 `notes pickup`** → Voice',
      '- [my-notes](my_notes.md) — **🔑 `my-notes pickup`** → HUD',
      '- [A](a.md) — 🔑 `doppelt pickup`',
      '- [B](b.md) — 🔑 `doppelt pickup`',
    ].join('\n'),
    mtimeMs: 0,
  })
  await $.session.start(START)
  expect((await $.command.run(typed('pause'))).text).toMatch(/^Diese Session sichert ihren Stand in my_notes\.md\./)
})

test('Zweideutige Phrase: sichert, kein Neustart', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'doppelt pickup', toolUses: [] }])
  seen.files.set(`${MEM}/MEMORY.md`, { text: '- [A](a.md) — 🔑 `doppelt pickup`\n- [B](b.md) — 🔑 `doppelt pickup`', mtimeMs: 0 })
  await $.session.start(START)
  expect((await $.command.run(typed('pause', 'neu'))).text).toMatch(/„doppelt pickup“ steht nicht als 🔑 in MEMORY\.md/)
})

test('Phrase ohne 🔑-Eintrag: sichert, startet aber nicht neu; Alias und Magic-Word gelten', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'garten pickup', toolUses: [] }])
  await $.session.start(START)
  const answer = await $.command.run(typed('pause', 'neu'))
  expect(answer.text).toMatch(/^Diese Session sichert ihren Stand; „garten pickup“ steht nicht als 🔑 in MEMORY\.md, darum startet sie nicht neu\./)
  await seen.clock.advance(300)
  expect(seen.prompts[0]).toMatch(/^Pause: Schreib jetzt den aktuellen Stand ins zuständige Memory/)
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

for (const [typedPhrase, file, phrase] of [
  ['tobi pickup', 'tobi_application.md', 'tobi pickup'],
  ['pickup tobi application', 'tobi_application.md', 'pickup tobi application'],
  ['abandoned resume', 'session_resume_abandoned.md', 'abandoned resume'],
  ['Kunde Pickup, bitte', 'session_resume.md', 'kunde pickup'],
] as const) {
  test(`„${typedPhrase}“ sichert nach ${file}`, async ($, on) => {
    const seen = engine(on, [{ role: 'user', text: typedPhrase, toolUses: [] }])
    await $.session.start(START)
    const answer = await $.command.run(typed('pause', 'neu'))
    expect(answer.text).toMatch(new RegExp(`^Diese Session sichert ihren Stand in ${file.replace('.', '\\.')} und startet danach frisch mit „${phrase}“`))
    await seen.clock.advance(300)
    await $.turn.start(SAVE_TURN)
    await $.tool.call({ tool: 'Write', file_path: `${MEM}/${file}`, content: 'Stand vom 13.10.' })
    await $.turn.complete(TURN)
    await seen.clock.settle()
    expect(seen.commands).toEqual(['clear'])
    expect(seen.fills).toEqual([phrase])
  })
}

test('Ohne MEMORY.md im Kontext gilt der Projektordner der Session', async ($, on) => {
  const seen = engine(on, undefined, [])
  on('session.root', () => ({ value: '/Users/mike/Projects/beispiel' }))
  const dir = '/home/mike/.claude/projects/-Users-mike-Projects-beispiel/memory'
  seen.files.set(`${dir}/MEMORY.md`, { text: '- [Mods](mods.md) — 🔑 `mods pickup`', mtimeMs: 0 })
  await $.session.start(START)
  const answer = await $.command.run(typed('pause'))
  expect(answer.text).toMatch(/^Diese Session sichert ihren Stand in mods\.md\./)
  await seen.clock.advance(300)
  expect(seen.prompts[0]).toContain(`${dir}/mods.md`)
})

test('Write: nur die neuen Zeilen zählen; fallen sie weg, obwohl der Kopf bleibt, kein Neustart', async ($, on) => {
  const seen = engine(on)
  seen.files.set(`${MEM}/mods.md`, { text: '---\nname: mods\n---\nStand alt', mtimeMs: 0 })
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Write', file_path: `${MEM}/mods.md`, content: '---\nname: mods\n---\nStand alt\nPause 10:00: F0 fertig' })
  // Eine andere Session schreibt die Datei neu: Kopf und alter Stand bleiben, die neue Zeile fehlt.
  seen.files.set(`${MEM}/mods.md`, { text: '---\nname: mods\n---\nStand alt\nnebenan', mtimeMs: NOW + HOUR })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
})

test('Überarbeitet die Session ihren eigenen Eintrag, startet sie trotzdem neu', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Write', file_path: `${MEM}/mods.md`, content: 'Stand alt\nPause: F0 fetrig' })
  await $.tool.call({ tool: 'Write', file_path: `${MEM}/mods.md`, content: 'Stand alt\nPause: F0 fertig' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
})

test('Ein vorher eingereihter anderer Turn bindet nicht, auch wenn er die Datei schreibt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'neu'))
  await $.turn.start({ text: 'noch schnell: trag X ein', turnId: 't0' })
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'X eingetragen' })
  await $.turn.complete({ ...TURN, turnId: 't0' })
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts).toEqual([])
  // Erst der Sicherungs-Turn entscheidet.
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'X eingetragen', new_string: 'Pause: Stand gesichert' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
})

test('Ohne Zieldatei bekommt der Empfänger trotzdem gesagt, ob er danach weitermacht', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'prüfe bitte die Jiras', toolUses: [] }])
  await $.session.start(START)
  await $.prompt.submit({ text: 'Mike macht Pause … [PAUSE-SICHERN]', wait: false, turnId: 't9', origin: { kind: 'peer-send-message' } })
  expect(lastOf(seen.prompts)).toBe('Mike macht Pause … [PAUSE-SICHERN]\nDu warst mitten in einer Arbeit: nach dem Sichern dort weitermachen, falls noch etwas offen ist.')
})

const MARK = '/home/mike/.claude/mod-daten/sessions/s-self.json'

test('/pause selbst: nur diese Session sichert und startet nach dem Nachweis frisch, niemand sonst wird angeschrieben', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  const answer = await $.command.run(typed('pause', 'selbst'))
  expect(answer.text).toBe('Diese Session sichert ihren Stand in mods.md und startet danach frisch mit „mods pickup“, sobald sie die Datei geschrieben hat.')
  expect(seen.sent).toEqual([])
  expect(seen.opened).toEqual([])
  await seen.clock.advance(300)
  expect(seen.prompts[0]).toMatch(/^Pause: Schreib jetzt den aktuellen Stand in .+\/mods\.md, die Datei, die „mods pickup“ einliest/)
  expect(seen.prompts[0]).toMatch(/\nDu hast auf Mike gewartet: nach dem Sichern nichts weiter tun\.$/)
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: Stand gesichert' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.fills).toEqual(['mods pickup'])
})

test('/pause selbst ohne Pickup-Datei: kein Sichern, kein Neustart, klare Meldung', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'continue', toolUses: [] }])
  await $.session.start(START)
  expect((await $.command.run(typed('pause', 'selbst'))).text).toBe('Kein Neustart: Diese Session begann ohne Pickup-Phrase, es gibt keine Pickup-Datei.')
  await seen.clock.advance(300)
  expect(seen.prompts).toEqual([])
})

test('Die Marke trägt Pickup-Phrase und Zieldatei, sobald sie bekannt sind', async ($, on) => {
  const rows: { role: 'user'; text: string; toolUses: never[] }[] = []
  const seen = engine(on, rows)
  await $.session.start(START)
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: '', file: '' })
  rows.push({ role: 'user', text: 'webshop pickup', toolUses: [] })
  await $.turn.start({ text: 'webshop pickup', turnId: 't1' })
  await $.turn.complete(TURN)
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: 'webshop pickup', file: `${MEM}/project_webshop_ui.md` })
})

test('/clear von Hand: die neue Session-ID bekommt ihre Marke, die neue Pickup-Phrase wird erkannt', async ($, on) => {
  const rows: { role: 'user'; text: string; toolUses: never[] }[] = [{ role: 'user', text: 'mods pickup', toolUses: [] }]
  const seen = engine(on, rows)
  await $.session.start(START)
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: 'mods pickup' })
  await $.session.end({ reason: 'clear', sessionId: 's-self', resume: { id: 's-self' } })
  seen.id = 's-neu'
  rows.length = 0
  await seen.clock.advance(400)
  const MARK2 = '/home/mike/.claude/mod-daten/sessions/s-neu.json'
  expect(JSON.parse(seen.writes.get(MARK2) ?? '{}')).toMatchObject({ pickup: '', file: '' })
  rows.push({ role: 'user', text: 'webshop pickup', toolUses: [] })
  await $.turn.start({ text: 'webshop pickup', turnId: 't5' })
  await $.turn.complete({ ...TURN, turnId: 't5' })
  expect(JSON.parse(seen.writes.get(MARK2) ?? '{}')).toMatchObject({ pickup: 'webshop pickup', file: `${MEM}/project_webshop_ui.md` })
})

test('Nach dem Neustart ist die Marke leer, bis der erste echte Turn die Phrase bestätigt; zweimal selbst sichert nur einmal', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'selbst'))
  expect((await $.command.run(typed('pause', 'selbst'))).text).toBe('Läuft schon: diese Session sichert gerade und startet danach neu.')
  await seen.clock.advance(300)
  expect(seen.prompts.length).toBe(1)
  await $.turn.start(SAVE_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: gesichert' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: '', file: '' })
})

test('Phrase ohne 🔑-Zeile landet in der Marke, damit das Fenster den Grund nennen kann', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'garten pickup', toolUses: [] }])
  await $.session.start(START)
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: 'garten pickup', file: '' })
})

test('Eine liegengebliebene Vormerkung sperrt /pause selbst nur 60 s', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'selbst'))
  // Der Sicherungs-Prompt startet nie einen Turn (verworfen).
  await seen.clock.advance(30_000)
  expect((await $.command.run(typed('pause', 'selbst'))).text).toMatch(/^Läuft schon/)
  await seen.clock.advance(31_000)
  expect((await $.command.run(typed('pause', 'selbst'))).text).toMatch(/^Diese Session sichert ihren Stand in mods\.md/)
})

// /pause auto: der Auto-Neustart des verbrauch-Mods. Wie /pause selbst, dazu die Auto-Weiter-Zeile und eine
// abgeschickte statt nur eingelegte Phrase.
const AUTO_TURN = { text: 'Pause (Auto-Neustart): Schreib jetzt den aktuellen Stand …', turnId: 't1' } as const
const GO = 'mods pickup\nAuto-Neustart: Prüf den Stand wie üblich gegen git/Prod, dann mach den Schritt aus `Auto-Weiter: ja` und arbeite danach im Plan weiter. Die Halt-Liste gilt: Braucht ein Schritt Mike, hör dort auf und frag ihn.'
const WAIT = 'mods pickup\nAuto-Neustart: Stand einlesen, prüfen, kurz berichten (inkl. Grund aus `Auto-Weiter: nein`), dann warten.'
const UNCLEAR = 'mods pickup\nAuto-Neustart: Stand einlesen, prüfen, kurz berichten, dann warten. Die Sicherung hatte keine eindeutige `Auto-Weiter`-Zeile.'

// Die Kennung aus dem letzten Auto-Auftrag (4 Hex-Zeichen in eckigen Klammern).
const tokenOf = (seen: ReturnType<typeof engine>): string => {
  const ask = seen.prompts.findLast(p => p.startsWith('Pause (Auto-Neustart): ')) ?? ''
  const k = /\[([0-9a-f]{4})\]/.exec(ask)?.[1]
  if (!k) throw new Error(`keine Kennung im Auto-Auftrag: ${ask}`)
  return k
}
// Eine andere gültige Kennung als k (eine alte aus einer früheren Sicherung).
const otherToken = (k: string): string => (k === '0000' ? 'ffff' : '0000')
// Setzt die Kennung ein: {k} wie im Auftrag, {K} in Grossbuchstaben, {alt} eine andere.
const withToken = (text: string, k: string): string =>
  text.replaceAll('{k}', k).replaceAll('{K}', k.toUpperCase()).replaceAll('{alt}', otherToken(k))

// Startet /pause auto, lässt den Sicherungs-Turn die Zeilen `lines` per Edit anhängen und beendet ihn. `start`
// ist der Inhalt der Datei vor dem Sicherungs-Turn (sonst bleibt er). Gibt die Kennung zurück.
const autoRun = async (
  $: Parameters<Parameters<typeof test>[1]>[0],
  seen: ReturnType<typeof engine>,
  lines: string[],
  start?: string,
): Promise<string> => {
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  const k = tokenOf(seen)
  if (start !== undefined) seen.files.set(`${MEM}/mods.md`, { text: withToken(start, k), mtimeMs: NOW - HOUR })
  await $.turn.start(AUTO_TURN)
  for (const line of lines) await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: withToken(line, k) })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  return k
}

test('/pause auto schickt den Auto-Auftrag; Auto-Weiter: ja → /clear und abgeschickte Phrase mit Weiter-Text', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  const answer = await $.command.run(typed('pause', 'auto'))
  expect(answer.text).toBe('Auto-Neustart: Diese Session sichert ihren Stand in mods.md und startet danach frisch mit „mods pickup“, sobald sie die Datei geschrieben hat; mit Auto-Weiter: ja arbeitet sie dann von selbst weiter.')
  expect(seen.sent).toEqual([])
  await seen.clock.advance(300)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toMatch(/^Pause \(Auto-Neustart\): Schreib jetzt den aktuellen Stand in .+\/mods\.md, die Datei, die „mods pickup“ einliest, wie beim MEMORY-HEARTBEAT\./)
  // Der Auftrag nennt die Kennung dieser Sicherung, in beiden Formen und im Satz danach dieselbe.
  const k = tokenOf(seen)
  expect(k).toMatch(/^[0-9a-f]{4}$/)
  expect(seen.prompts[0]).toContain(
    `genau eine Zeile \`Auto-Weiter: ja — <nächster konkreter Schritt> [${k}]\` oder \`Auto-Weiter: nein — <Grund> [${k}]\`, mit der Kennung [${k}] dieser Sicherung am Ende.`,
  )
  expect(seen.prompts[0].match(/\[[0-9a-f]{4}\]/g)).toEqual([`[${k}]`, `[${k}]`, `[${k}]`])
  expect(seen.prompts[0]).toContain('ersetz sie durch die neue, auch wenn sie sonst gleich bleibt, statt eine zweite anzuhängen')
  expect(seen.prompts[0]).toContain('etwas zeigen oder abnehmen lassen, eine Entscheidung aus dem Plan, Geld, Rechtliches, ein Prod-Deploy')
  expect(seen.prompts[0]).toContain('zuletzt eine Frage gestellt hast (dann die Frage mit in die Datei)')
  expect(seen.prompts[0]).toMatch(/Nichts nachfragen, nicht zurückschreiben, danach nichts weiter tun\.$/)
  await $.turn.start(AUTO_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: `Pause: F1 fertig\nAuto-Weiter: ja — F2 bauen [${k}]` })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.fills).toEqual([])
  expect(seen.prompts.slice(1)).toEqual([GO])
  expect(seen.toasts).toEqual([])
  // Die Marke der frischen Session ist leer, bis der erste Turn die Phrase bestätigt.
  expect(JSON.parse(seen.writes.get(MARK) ?? '{}')).toMatchObject({ pickup: '', file: '' })
})

for (const [name, lines, expected] of [
  ['nein', ['Pause: Plan F3 offen', 'Auto-Weiter: nein — Mike muss F2 abnehmen [{k}]'], WAIT],
  ['nein als fetter Listenpunkt', ['- **Auto-Weiter:** Nein — Entscheidung E7 [{k}]'], WAIT],
  ['fehlend', ['Pause: F1 fertig'], UNCLEAR],
  ['doppelt', ['Auto-Weiter: ja — F2 [{k}]', 'Auto-Weiter: nein — doch nicht [{k}]'], UNCLEAR],
] as const) {
  test(`/pause auto, Auto-Weiter ${name}: frisch mit Warte-Text`, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await autoRun($, seen, [...lines])
    expect(seen.commands).toEqual(['clear'])
    expect(seen.fills).toEqual([])
    expect(lastOf(seen.prompts)).toBe(expected)
    expect(seen.toasts).toEqual(expected === UNCLEAR ? ['Auto-Neustart: mods.md hat keine eindeutige Auto-Weiter-Zeile mit der Kennung dieser Sicherung, die frische Session wartet.'] : [])
  })
}

test('/pause auto: Markup wird erkannt (Liste, fett, Backticks, Überschrift), Fremdes nicht', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  const lines = ['- **Auto-Weiter:** ja — F2 [{k}]', '* `Auto-Weiter: ja — F2 [{k}]`', '**Auto-Weiter: ja** — F2 [{k}]', '## Auto-Weiter: JA – F2 [{k}]', '1. Auto-Weiter:ja [{k}]']
  // Jede Zeile allein in der Datei: je ein Durchlauf mit frischem Inhalt.
  for (const line of lines) {
    seen.files.set(`${MEM}/mods.md`, { text: 'Stand alt', mtimeMs: 0 })
    await autoRun($, seen, [line])
    expect(lastOf(seen.prompts)).toBe(GO)
    await seen.clock.advance(61_000)
  }
  // "jaein" ist kein ja, "Auto-Weiter" mitten im Satz keine Zeile.
  for (const line of ['Auto-Weiter: jaein [{k}]', 'Notiz: Auto-Weiter: ja steht unten [{k}]']) {
    seen.files.set(`${MEM}/mods.md`, { text: 'Stand alt', mtimeMs: 0 })
    await autoRun($, seen, [line])
    expect(lastOf(seen.prompts)).toBe(UNCLEAR)
    await seen.clock.advance(61_000)
  }
  expect(seen.commands.length).toBe(7)
})

test('/pause auto: eine alte Auto-Weiter-Zeile aus einem früheren Turn zählt nicht, eine ersetzte schon', async ($, on) => {
  const seen = engine(on)
  seen.files.set(`${MEM}/mods.md`, { text: 'Stand alt\nAuto-Weiter: ja — F1 bauen', mtimeMs: NOW - HOUR })
  await $.session.start(START)
  await autoRun($, seen, ['Pause: F1 halb fertig'])
  expect(seen.commands).toEqual(['clear'])
  expect(lastOf(seen.prompts)).toBe(UNCLEAR)
  // Ersetzt die Session die alte Zeile durch eine neue, gilt die neue.
  seen.files.set(`${MEM}/mods.md`, { text: 'Stand alt\nAuto-Weiter: nein — alt', mtimeMs: NOW - HOUR })
  await seen.clock.advance(61_000)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  const k = tokenOf(seen)
  await $.turn.start({ ...AUTO_TURN, turnId: 't2' })
  await $.tool.call({ tool: 'Write', file_path: `${MEM}/mods.md`, content: `Stand alt\nPause: F1 fertig\nAuto-Weiter: ja — F2 [${k}]` })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear', 'clear'])
  expect(lastOf(seen.prompts)).toBe(GO)
})

// Der Fall aus dem Live-Test: die Zeile stand schon vor dem Sicherungs-Turn in der Datei (Auto-Weiter: nein — Plan
// fertig) und bleibt Wort für Wort gleich; nur die Kennung ist neu. Das gilt jetzt als ja bzw. nein.
for (const [value, expected] of [
  ['nein — Plan fertig', WAIT],
  ['ja — Schritt 4', GO],
] as const) {
  for (const before of [`Auto-Weiter: ${value}`, `Auto-Weiter: ${value} [{alt}]`]) {
    test(`/pause auto: „${before}“ stand schon da, die Sicherung schreibt sie gleich mit neuer Kennung → ${expected === GO ? 'ja' : 'nein'}`, async ($, on) => {
      const seen = engine(on)
      await $.session.start(START)
      await $.command.run(typed('pause', 'auto'))
      await seen.clock.advance(300)
      const k = tokenOf(seen)
      seen.files.set(`${MEM}/mods.md`, { text: withToken(`Stand alt\n${before}`, k), mtimeMs: NOW - HOUR })
      await $.turn.start(AUTO_TURN)
      await $.tool.call({ tool: 'Write', file_path: `${MEM}/mods.md`, content: `Stand alt\nPause: gesichert\nAuto-Weiter: ${value} [${k}]` })
      await $.turn.complete(TURN)
      await seen.clock.settle()
      expect(seen.commands).toEqual(['clear'])
      expect(lastOf(seen.prompts)).toBe(expected)
      expect(seen.toasts).toEqual([])
    })
  }
}

test('/pause auto: die Zeile mit der Kennung zählt, auch wenn sie keine Nachweis-Zeile ist; ohne Nachweis überhaupt kein Neustart', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  const k = tokenOf(seen)
  await $.turn.start(AUTO_TURN)
  // Die Auto-Weiter-Zeile kommt auf einem Weg in die Datei, den der Mod nicht zuordnet; der Stand per Edit schon.
  seen.files.set(`${MEM}/mods.md`, { text: `Stand alt\nAuto-Weiter: ja — F2 [${k}]`, mtimeMs: NOW })
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: F1 fertig' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(lastOf(seen.prompts)).toBe(GO)

  // Steht nur die Zeile mit der Kennung da, aber nichts nachweislich Geschriebenes: der Nachweis bleibt Bedingung.
  await seen.clock.advance(61_000)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  const k2 = tokenOf(seen)
  await $.turn.start({ ...AUTO_TURN, turnId: 't2' })
  seen.files.set(`${MEM}/mods.md`, { text: `Stand alt\nAuto-Weiter: ja — F3 [${k2}]`, mtimeMs: NOW })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(lastOf(seen.toasts)).toBe('Kein Neustart nach /pause: mods.md wurde nicht geschrieben, der Kontext bleibt.')
})

for (const [name, start, lines] of [
  ['alte Kennung', 'Stand alt', ['Auto-Weiter: ja — F2 [{alt}]']],
  ['keine Kennung', 'Stand alt', ['Auto-Weiter: ja — F2']],
  ['zwei Zeilen, eine mit der Kennung', 'Stand alt\nAuto-Weiter: nein — Plan fertig [{alt}]', ['Pause: F2 offen', 'Auto-Weiter: ja — F2 [{k}]']],
  ['zwei Zeilen, beide mit der Kennung', 'Stand alt', ['Auto-Weiter: ja — F2 [{k}]', '- **Auto-Weiter:** ja — F2 [{k}]']],
] as const) {
  test(`/pause auto: ${name} → unklar`, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await autoRun($, seen, [...lines], start)
    expect(seen.commands).toEqual(['clear'])
    expect(lastOf(seen.prompts)).toBe(UNCLEAR)
  })
}

test('/pause auto ohne Nachweis: kein /clear, keine Phrase, der Kontext bleibt', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  await $.turn.start(AUTO_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/session_resume.md`, old_string: 'a', new_string: 'Auto-Weiter: ja — X' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.prompts.length).toBe(1)
  expect(seen.toasts).toEqual(['Kein Neustart nach /pause: mods.md wurde nicht geschrieben, der Kontext bleibt.'])
})

test('/pause auto bindet nur den Auto-Auftrag, nicht einen Turn mit dem Text von /pause selbst', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  await $.turn.start({ ...SAVE_TURN, turnId: 't0' })
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Auto-Weiter: ja — X' })
  await $.turn.complete({ ...TURN, turnId: 't0' })
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('/pause auto ohne Pickup-Datei: keine Sicherung, klare Meldung', async ($, on) => {
  const seen = engine(on, [{ role: 'user', text: 'continue', toolUses: [] }])
  await $.session.start(START)
  expect((await $.command.run(typed('pause', 'auto'))).text).toBe('Kein Neustart: Diese Session begann ohne Pickup-Phrase, es gibt keine Pickup-Datei.')
  await seen.clock.advance(300)
  expect(seen.prompts).toEqual([])
})

for (const arg of ['selbst', 'neu'] as const) {
  test(`/pause ${arg} bleibt beim Füllen, auch wenn die Datei eine Auto-Weiter-Zeile bekommt`, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.command.run(typed('pause', arg))
    await seen.clock.advance(300)
    await $.turn.start(SAVE_TURN)
    await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: X\nAuto-Weiter: ja — Y' })
    await $.turn.complete(TURN)
    await seen.clock.settle()
    expect(seen.commands).toEqual(['clear'])
    expect(seen.fills).toEqual(['mods pickup'])
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toMatch(/^Pause: Schreib jetzt /)
    // Ohne auto kein Auto-Auftrag und keine Kennung.
    expect(seen.prompts[0]).not.toMatch(/Auto-Weiter|Kennung|\[[0-9a-f]{4}\]/)
    expect((await $.command.run(typed('pause', 'automatisch'))).text).toMatch(/^Aufruf: .+, \/pause auto \(.+ oder \/pause abbrechen \(/)
  })
}

for (const [line, expected] of [
  ['**Auto-Weiter**: ja — F2 [{k}]', GO],
  ['Auto-Weiter: nein: Mike muss abnehmen [{k}]', WAIT],
  ['Auto-Weiter: ja. [{k}]', GO],
  ['Auto-Weiter: ja [{k}]', GO],
  // Die Kennung am Ende stört den Wert nicht.
  ['Auto-Weiter: ja — Schritt 4 [{k}]', GO],
  ['**Auto-Weiter:** nein — fertig [{k}]', WAIT],
  ['`Auto-Weiter: nein — Mike muss abnehmen [{k}]`', WAIT],
  // Die Kennung in Grossbuchstaben zählt; ohne eckige Klammern, mit anderen Klammern oder Leerraum darin nicht.
  ['Auto-Weiter: ja — F2 [{K}]', GO],
  ['Auto-Weiter: ja — F2 {k}', UNCLEAR],
  ['Auto-Weiter: ja — F2 ({k})', UNCLEAR],
  ['Auto-Weiter: ja — F2 [ {k} ]', UNCLEAR],
  ['Auto-Weiter: ja — F2 [{k}0]', UNCLEAR],
  ['Auto-Weiter: ja — F2 [#{k}]', UNCLEAR],
  ['Auto-Weiter: ja|nein [{k}]', UNCLEAR],
  ['Auto-Weiter: ja/nein [{k}]', UNCLEAR],
  ['Auto-Weiter: ja<nein [{k}]', UNCLEAR],
  // Der zurückgeschriebene Auftrag, auch mit der Kennung, ganz oder nur die ja-Hälfte (Platzhalter mit <).
  ['`Auto-Weiter: ja — <nächster konkreter Schritt> [{k}]` oder `Auto-Weiter: nein — <Grund> [{k}]`', UNCLEAR],
  ['`Auto-Weiter: ja — <nächster konkreter Schritt> [{k}]`', UNCLEAR],
  ['Auto-Weiter: ja — <nächster Schritt> [{k}]', UNCLEAR],
  ['Auto-Weiter: nein — ja, sobald Mike zustimmt [{k}]', UNCLEAR],
  // Ein einzelnes < in einem echten Schritt ist kein Platzhalter.
  ['Auto-Weiter: ja — prüfen, ob Kontext < 200k bleibt [{k}]', GO],
  ['Auto-Weiter: nein — warten, bis Last < 50 % [{k}]', WAIT],
  ['Auto-Weiter: ja — F2 <…> [{k}]', UNCLEAR],
  ['Auto-Weiter: ja — F2 <...> [{k}]', UNCLEAR],
  ['Auto-Weiter: nein — <Grund> [{k}]', UNCLEAR],
  ['Auto-Weiter: ja — Pane-Zeile mit `<Box>` bauen [{k}]', GO],
  ['Auto-Weiter: ja — Typ Record<string, number> nachziehen [{k}]', GO],
] as const) {
  test(`/pause auto liest „${line}“ als ${expected === GO ? 'ja' : expected === WAIT ? 'nein' : 'unklar'}`, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await autoRun($, seen, [line])
    expect(seen.commands).toEqual(['clear'])
    expect(lastOf(seen.prompts)).toBe(expected)
  })
}

// Mike meldet sich, nachdem verbrauch den Auto-Neustart schon übergab: der Sicherungs-Turn sichert, startet aber nicht neu.
for (const [name, interrupt] of [
  ['Prompt am Rechner', async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
    await $.prompt.submit({ text: 'halt, warte', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  }],
  ['Prompt vom Telefon', async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
    await $.prompt.submit({ text: 'halt', wait: false, turnId: 't1', origin: { kind: 'bridge' } })
  }],
  ['/pause abbrechen', async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
    expect((await $.command.run(typed('pause', 'abbrechen'))).text).toBe('Neustart abgebrochen: diese Session startet nach dem Sichern nicht neu, der Kontext bleibt.')
  }],
] as const) {
  test(`Auto-Neustart abgebrochen im Sicherungs-Turn (${name}): kein /clear`, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.command.run(typed('pause', 'auto'))
    await seen.clock.advance(300)
    await $.turn.start(AUTO_TURN)
    await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: X\nAuto-Weiter: ja — Y' })
    await interrupt($)
    await $.turn.complete(TURN)
    await seen.clock.settle()
    expect(seen.commands).toEqual([])
    expect(seen.prompts.length).toBe(name === '/pause abbrechen' ? 1 : 2)
    if (name !== '/pause abbrechen') expect(lastOf(seen.toasts)).toBe('Auto-Neustart abgebrochen: du hast geschrieben.')
  })
}

test('/auto aus im Sicherungs-Turn (Abbruch-Datei von verbrauch): kein /clear; eine alte Datei zählt nicht', async ($, on) => {
  const seen = engine(on)
  const STOP = '/home/mike/.claude/mod-daten/sessions/s-self.abbruch'
  // Von einem früheren Abbruch: älter als die Vormerkung.
  seen.files.set(STOP, { text: JSON.stringify({ at: NOW - HOUR }), mtimeMs: 0 })
  await $.session.start(START)
  await autoRun($, seen, ['Auto-Weiter: ja — F2'])
  expect(seen.commands).toEqual(['clear'])
  // Jetzt nach der Vormerkung abgebrochen.
  await seen.clock.advance(61_000)
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  await $.turn.start({ ...AUTO_TURN, turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'x', new_string: 'Pause: Y' })
  seen.files.set(STOP, { text: JSON.stringify({ at: seen.clock.now() }), mtimeMs: 0 })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart abgebrochen (/auto aus): gesichert, aber kein Neustart, der Kontext bleibt.')
})

test('/auto aus knapp vor dem Vormerken (Lücke zwischen verbrauch und sessions): kein /clear', async ($, on) => {
  const seen = engine(on)
  const STOP = '/home/mike/.claude/mod-daten/sessions/s-self.abbruch'
  await $.session.start(START)
  // verbrauch hat ausgelöst, /auto aus kam 2 s bevor sessions vormerkt.
  seen.files.set(STOP, { text: JSON.stringify({ at: seen.clock.now() - 2_000 }), mtimeMs: 0 })
  await $.command.run(typed('pause', 'auto'))
  await seen.clock.advance(300)
  await $.turn.start(AUTO_TURN)
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: Y\nAuto-Weiter: ja — F2' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual([])
  expect(lastOf(seen.toasts)).toBe('Auto-Neustart abgebrochen (/auto aus): gesichert, aber kein Neustart, der Kontext bleibt.')
})

test('/pause abbrechen ohne Vormerkung; ein Prompt hält /pause selbst nicht an', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  expect((await $.command.run(typed('pause', 'abbrechen'))).text).toBe('Kein Neustart vorgemerkt.')
  await $.command.run(typed('pause', 'selbst'))
  await seen.clock.advance(300)
  await $.turn.start(SAVE_TURN)
  await $.prompt.submit({ text: 'noch was', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'Stand alt', new_string: 'Pause: gesichert' })
  await $.turn.complete(TURN)
  await seen.clock.settle()
  expect(seen.commands).toEqual(['clear'])
  expect(seen.fills).toEqual(['mods pickup'])
})

test('Ablauf wie echt: zwei Auto-Neustarts nacheinander über /clear und neue Session-ID', async ($, on) => {
  const rows: { role: 'user'; text: string; toolUses: never[] }[] = [{ role: 'user', text: 'mods pickup', toolUses: [] }]
  const seen = engine(on, rows)
  await $.session.start(START)
  for (const [n, id] of [[1, 's-zwei'], [2, 's-drei']] as const) {
    await $.command.run(typed('pause', 'auto'))
    await seen.clock.advance(300)
    await $.turn.start({ ...AUTO_TURN, turnId: `save${n}` })
    await $.tool.call({ tool: 'Edit', file_path: `${MEM}/mods.md`, old_string: 'x', new_string: `Pause ${n}: Stand\nAuto-Weiter: ja — Schritt ${n + 1} [${tokenOf(seen)}]` })
    await $.turn.complete({ ...TURN, turnId: `save${n}` })
    await seen.clock.settle()
    expect(seen.commands.length).toBe(n)
    expect(lastOf(seen.prompts)).toMatch(/^mods pickup\nAuto-Neustart: Prüf den Stand/)
    // Die Engine: /clear beendet die Session, die neue ID beginnt mit der abgeschickten Phrase.
    await $.session.end({ reason: 'clear', sessionId: seen.id, resume: { id: seen.id } })
    seen.id = id
    rows.length = 0
    rows.push({ role: 'user', text: lastOf(seen.prompts) ?? '', toolUses: [] })
    await seen.clock.advance(400)
    await $.turn.start({ text: lastOf(seen.prompts) ?? '', turnId: `pickup${n}` })
    await $.turn.complete({ ...TURN, turnId: `pickup${n}` })
    expect(JSON.parse(seen.writes.get(`/home/mike/.claude/mod-daten/sessions/${id}.json`) ?? '{}')).toMatchObject({ pickup: 'mods pickup', file: `${MEM}/mods.md` })
    // Die alte Auto-Weiter-Zeile bleibt in der Datei; der nächste Durchlauf muss sie ersetzen.
    seen.files.set(`${MEM}/mods.md`, { text: 'Stand alt', mtimeMs: 0 })
  }
  expect(seen.commands).toEqual(['clear', 'clear'])
})
