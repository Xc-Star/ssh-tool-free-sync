import { GroupEditor } from './hosts/GroupEditor'
import { HostEditor } from './hosts/HostEditor'
import { IdentityEditor } from './keychain/IdentityEditor'
import { KeyEditor } from './keychain/KeyEditor'
import { PortForwardEditor } from './port-forwarding/PortForwardEditor'
import { SnippetEditor } from './snippets/SnippetEditor'
import { closeEditor, useUi } from '@/stores/ui'

/** Mounts the active right-side editor drawer (any page can open one through openEditor()). */
export function Editors(): React.JSX.Element | null {
  const editor = useUi((s) => s.editor)
  if (!editor) return null
  const key = `${editor.kind}-${editor.id ?? 'new'}-${editor.nonce}`
  const props = { id: editor.id, defaults: editor.defaults, onClose: closeEditor }
  switch (editor.kind) {
    case 'host':
      return <HostEditor key={key} {...props} />
    case 'group':
      return <GroupEditor key={key} {...props} />
    case 'key':
      return <KeyEditor key={key} {...props} />
    case 'identity':
      return <IdentityEditor key={key} {...props} />
    case 'snippet':
      return <SnippetEditor key={key} {...props} />
    case 'portForward':
      return <PortForwardEditor key={key} {...props} />
    default:
      return null
  }
}