import { lazy, Suspense, useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { on } from '@/lib/api'
import { useUi } from '@/stores/ui'
import { switchSource } from './actions'
import { FilePane } from './FilePane'
import { PermissionsDialog } from './PermissionsDialog'
import { closeChmodDialog, closeEditorDialog, initSftp, refreshMatching, resetSftp, useSftp } from './store'
import { TransfersPanel } from './TransfersPanel'

const TextEditorDialog = lazy(() => import('./TextEditorDialog'))

// Last handled "Open in SFTP" request (module level so a remount does not replay it).
let handledNonce = 0

/** Content of the pinned SFTP tab: two file panes side by side plus the transfer queue. */
export function SftpPage(): React.JSX.Element {
  const request = useUi((s) => s.sftpRequest)
  const editor = useSftp((s) => s.editor)
  const chmod = useSftp((s) => s.chmod)
  const layout = useDefaultLayout({ id: 'sshtool-sftp-panes', storage: localStorage })

  useEffect(() => {
    initSftp()
    const off = on('fs.changed', ({ fsId, dir }) => void refreshMatching(fsId, dir))
    return () => {
      off()
      resetSftp()
    }
  }, [])

  useEffect(() => {
    if (!request || request.nonce === handledNonce) return
    handledNonce = request.nonce
    // Reuses the terminal's SSH connection; a pane already showing that host is left as is.
    void switchSource('right', { kind: 'host', hostId: request.hostId, sessionId: request.sessionId })
  }, [request])

  return (
    <div className="flex h-full flex-col gap-2 bg-app p-2" data-testid="sftp-page">
      <Group orientation="horizontal" id="sshtool-sftp-panes" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
        <Panel id="left" minSize="22">
          <FilePane paneId="left" />
        </Panel>
        <Separator className="group flex w-2 items-center justify-center outline-none">
          <div className="h-8 w-[3px] rounded-full bg-line-strong opacity-0 transition-[opacity,background-color] group-hover:opacity-100 group-data-[separator=active]:bg-accent group-data-[separator=active]:opacity-100 group-data-[separator=focus]:opacity-100" />
        </Separator>
        <Panel id="right" minSize="22">
          <FilePane paneId="right" />
        </Panel>
      </Group>
      <TransfersPanel />
      {editor && (
        <Suspense fallback={null}>
          <TextEditorDialog key={`${editor.fsId}:${editor.path}`} target={editor} onClose={closeEditorDialog} />
        </Suspense>
      )}
      {chmod && <PermissionsDialog key={chmod.entries.map((e) => e.path).join('\n')} target={chmod} onClose={closeChmodDialog} />}
    </div>
  )
}
