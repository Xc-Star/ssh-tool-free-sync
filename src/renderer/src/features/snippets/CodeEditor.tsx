import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { Annotation, Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, placeholder as placeholderExt } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'

export type CodeLanguage = 'shell' | 'text'

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: CodeLanguage
  /** Number = px, string = any CSS length. */
  minHeight?: number | string
  maxHeight?: number | string
  readOnly?: boolean
  autoFocus?: boolean
  placeholder?: string
  /** Shows the error border. */
  invalid?: boolean
  ariaLabel?: string
  className?: string
}

const shellLanguage = StreamLanguage.define(shell)
/** Marks transactions that mirror the controlled `value` so they are not echoed back through onChange. */
const External = Annotation.define<boolean>()

const MONO = "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** Makes CodeMirror blend into the app (transparent background, app font, tokens for chrome). */
const appTheme = Prec.highest(
  EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--c-fg)', fontSize: '12.5px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: MONO, lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--c-accent)' },
    '.cm-line': { padding: '0 12px 0 6px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--c-subtle)',
      border: 'none',
      borderRight: '1px solid var(--c-line)'
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px', minWidth: '30px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--c-muted)' },
    '&:not(.cm-focused) .cm-activeLine': { backgroundColor: 'transparent' },
    '&:not(.cm-focused) .cm-activeLineGutter': { color: 'inherit' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-accent)', borderLeftWidth: '2px' },
    '.cm-placeholder': { color: 'var(--c-subtle)', fontStyle: 'normal' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--c-panel-hover)',
      border: 'none',
      color: 'var(--c-muted)',
      padding: '0 4px'
    },
    '.cm-panels': { backgroundColor: 'var(--c-panel)', color: 'var(--c-fg)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--c-line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--c-line)' },
    '.cm-panel input, .cm-panel button': { fontSize: '12px' },
    '.cm-tooltip': {
      backgroundColor: 'var(--c-elevated)',
      color: 'var(--c-fg)',
      border: '1px solid var(--c-line)',
      borderRadius: '6px',
      boxShadow: 'var(--shadow-pop)'
    }
  })
)

function css(v: number | string | undefined): string | undefined {
  return typeof v === 'number' ? `${v}px` : v
}

function themeExt(dark: boolean): Extension {
  return dark ? oneDark : []
}

function languageExt(language: CodeLanguage): Extension {
  return language === 'shell' ? shellLanguage : []
}

function sizeExt(minHeight: number | string | undefined, maxHeight: number | string | undefined): Extension {
  return EditorView.theme({
    '&': { maxHeight: css(maxHeight) ?? 'none' },
    '.cm-content, .cm-gutter': { minHeight: css(minHeight) ?? '0' }
  })
}

function editableExt(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

function placeholderOf(text: string | undefined): Extension {
  return text ? placeholderExt(text) : []
}

function ariaExt(label: string | undefined): Extension {
  return label ? EditorView.contentAttributes.of({ 'aria-label': label }) : []
}

/**
 * Controlled CodeMirror 6 editor (shell highlighting, One Dark in the dark theme). The view is created once;
 * later prop changes are applied through compartments and external `value` changes are dispatched as edits.
 */
export function CodeEditor({
  value,
  onChange,
  language = 'shell',
  minHeight = 120,
  maxHeight,
  readOnly = false,
  autoFocus = false,
  placeholder,
  invalid,
  ariaLabel,
  className
}: CodeEditorProps): React.JSX.Element {
  const dark = useApp((s) => s.resolvedTheme === 'dark')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const [compartments] = useState(() => ({
    theme: new Compartment(),
    language: new Compartment(),
    size: new Compartment(),
    editable: new Compartment(),
    placeholder: new Compartment(),
    aria: new Compartment()
  }))

  useLayoutEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const c = compartments
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          appTheme,
          c.theme.of(themeExt(dark)),
          c.language.of(languageExt(language)),
          c.size.of(sizeExt(minHeight, maxHeight)),
          c.editable.of(editableExt(readOnly)),
          c.placeholder.of(placeholderOf(placeholder)),
          c.aria.of(ariaExt(ariaLabel)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return
            onChangeRef.current?.(u.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    if (autoFocus && !readOnly) {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The view is created once; the effects below keep it in sync with later prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: External.of(true) })
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(themeExt(dark)) })
  }, [compartments, dark])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.language.reconfigure(languageExt(language)) })
  }, [compartments, language])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.size.reconfigure(sizeExt(minHeight, maxHeight))
    })
  }, [compartments, minHeight, maxHeight])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.editable.reconfigure(editableExt(readOnly)) })
  }, [compartments, readOnly])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.placeholder.reconfigure(placeholderOf(placeholder)),
        compartments.aria.reconfigure(ariaExt(ariaLabel))
      ]
    })
  }, [compartments, placeholder, ariaLabel])

  return (
    <div
      ref={hostRef}
      className={cn(
        'selectable overflow-hidden rounded-md border bg-input text-left transition-colors',
        invalid ? 'border-danger' : 'border-line',
        !readOnly && 'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
        className
      )}
    />
  )
}
