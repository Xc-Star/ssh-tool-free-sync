import { Compartment, EditorState, Prec, type Text } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { AppWindow, LoaderCircle, RotateCw, Save, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatBytes } from '@shared/util'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { call, errorMessage, isMac } from '@/lib/api'
import { useApp } from '@/stores/app'
import { EntryIcon } from './icons'
import { detectLanguage } from './languages'
import { type EditorTarget, refreshMatching } from './store'

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'binary' | 'tooLarge'; size: number } | { kind: 'ready'; size: number }

const MONO = "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** Blends the editor into the app chrome (works on top of both the light default theme and oneDark). */
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--c-input)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--c-input)', borderRight: '1px solid var(--c-line)', color: 'var(--c-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--c-fg)' },
  '.cm-panels': { backgroundColor: 'var(--c-panel)', color: 'var(--c-fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--c-line)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' }
})

export default function TextEditorDialog({ target, onClose }: { target: EditorTarget; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation('sftp')
  const { t: tc } = useTranslation()
  const dark = useApp((s) => s.resolvedTheme === 'dark')
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pos, setPos] = useState({ line: 1, col: 1 })
  const [langName, setLangName] = useState<string>()
  const [eol, setEol] = useState<'\n' | '\r\n'>('\n')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef('')
  const savedDoc = useRef<Text | null>(null)
  const [themeComp] = useState(() => new Compartment())
  const [langComp] = useState(() => new Compartment())
  const saveRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false
    setLoad({ kind: 'loading' })
    call('fs.readText', target.fsId, target.path).then(
      (res) => {
        if (cancelled) return
        if (res.binary) setLoad({ kind: 'binary', size: res.size })
        else if (res.tooLarge) setLoad({ kind: 'tooLarge', size: res.size })
        else {
          contentRef.current = res.content
          setLoad({ kind: 'ready', size: res.size })
        }
      },
      (err) => !cancelled && setLoad({ kind: 'error', message: errorMessage(err) })
    )
    return () => {
      cancelled = true
    }
  }, [target, attempt])

  // Create the CodeMirror view once the content is available.
  useEffect(() => {
    if (load.kind !== 'ready' || !hostRef.current) return
    const content = contentRef.current
    const lineSep = content.includes('\r\n') ? '\r\n' : '\n'
    setEol(lineSep)
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  void saveRef.current()
                  return true
                }
              }
            ])
          ),
          basicSetup,
          themeComp.of(useApp.getState().resolvedTheme === 'dark' ? oneDark : []),
          Prec.highest(chrome),
          langComp.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && savedDoc.current) setDirty(!u.state.doc.eq(savedDoc.current))
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head
              const line = u.state.doc.lineAt(head)
              setPos({ line: line.number, col: head - line.from + 1 })
            }
          })
        ]
      })
    })
    savedDoc.current = view.state.doc
    viewRef.current = view
    setDirty(false)
    setPos({ line: 1, col: 1 })
    view.focus()
    const lang = detectLanguage(target.name, target.path, content)
    setLangName(lang?.name)
    if (lang) {
      lang
        .load()
        .then((ext) => {
          if (viewRef.current === view) view.dispatch({ effects: langComp.reconfigure(ext) })
        })
        .catch(() => {})
    }
    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.reconfigure(dark ? oneDark : []) })
  }, [dark, themeComp])

  saveRef.current = async () => {
    const view = viewRef.current
    if (!view || saving) return
    const doc = view.state.doc
    setSaving(true)
    try {
      await call('fs.writeText', target.fsId, target.path, doc.sliceString(0, doc.length, eol))
      savedDoc.current = doc
      setDirty(!view.state.doc.eq(doc))
      toast.success(t('fileSaved', { name: target.name }))
      void refreshMatching(target.fsId, target.dir)
    } catch (err) {
      toast.error(t('saveFailed'), { description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const requestClose = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true })
      if (!ok) return
    }
    onClose()
  }

  const openExternal = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: tc('unsavedTitle'), message: tc('unsaved'), confirmLabel: tc('discard'), danger: true }))) return
    try {
      await call('fs.editExternal', target.fsId, target.path)
      if (target.fsId !== 'local') toast.info(t('externalEditStarted', { name: target.name }), { description: t('externalEditHint') })
      onClose()
    } catch (err) {
      toast.error(t('openFailed'), { description: errorMessage(err) })
    }
  }

  const ready = load.kind === 'ready'

  return (
    <Dialog open onOpenChange={(o) => !o && void requestClose()}>
      <DialogContent
        width="max-w-6xl"
        className="h-[85vh]"
        data-testid="sftp-editor"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <EntryIcon entry={{ name: target.name, path: target.path, type: 'file' }} className="size-4 shrink-0" />
            <span className="truncate">{target.name}</span>
            {dirty && <span className="size-2 shrink-0 rounded-full bg-warning" title={t('unsavedChanges')} data-testid="sftp-editor-dirty" />}
          </span>
        }
        description={<span className="selectable block truncate font-mono">{target.path}</span>}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          // Let CodeMirror close its own search panel / completion popup first.
          const el = e.target as HTMLElement | null
          if (el?.closest?.('.cm-panels') || document.querySelector('.cm-tooltip-autocomplete')) e.preventDefault()
        }}
        onKeyDown={(e) => {
          if (!e.defaultPrevented && (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void saveRef.current()
          }
        }}
      >
        <div className="mx-5 mt-1 min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-input">
          {ready && <div ref={hostRef} className="h-full" />}
          {load.kind === 'loading' && (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
              <LoaderCircle className="size-4 animate-spin" />
              {t('editorLoading')}
            </div>
          )}
          {load.kind === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
                <TriangleAlert className="size-6" />
              </div>
              <div className="text-[14px] font-semibold">{t('editorLoadFailed')}</div>
              <div className="selectable max-w-lg break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{load.message}</div>
              <Button size="sm" variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw />
                {tc('retry')}
              </Button>
            </div>
          )}
          {(load.kind === 'binary' || load.kind === 'tooLarge') && (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-testid="sftp-editor-unsupported">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-warning/12 text-warning">
                <TriangleAlert className="size-6" />
              </div>
              <div className="text-[14px] font-semibold">{load.kind === 'binary' ? t('binaryFile') : t('tooLarge')}</div>
              <div className="max-w-md text-xs leading-relaxed text-muted">
                {load.kind === 'binary' ? t('binaryHint') : t('tooLargeHint', { size: formatBytes(load.size) })}
              </div>
              <Button size="sm" variant="primary" onClick={() => void openExternal()}>
                <AppWindow />
                {t('editExternal')}
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 px-5 pb-4 pt-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 truncate text-xs text-subtle">
            {ready && (
              <>
                <span className="tabular-nums" data-testid="sftp-editor-pos">
                  {t('lineCol', pos)}
                </span>
                <span>{langName ?? t('plainText')}</span>
                <span>{eol === '\r\n' ? 'CRLF' : 'LF'}</span>
                <span>UTF-8</span>
                <span className="tabular-nums">{formatBytes(load.size)}</span>
              </>
            )}
          </div>
          {ready && (
            <Button variant="ghost" size="sm" onClick={() => void openExternal()}>
              <AppWindow />
              {t('editExternal')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => void requestClose()}>
            {tc('close')}
          </Button>
          <Button variant="primary" disabled={!ready || !dirty || saving} onClick={() => void saveRef.current()} data-testid="sftp-editor-save">
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            {tc('save')}
            <span className="text-[11px] font-normal opacity-70">{isMac ? '⌘S' : 'Ctrl+S'}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
