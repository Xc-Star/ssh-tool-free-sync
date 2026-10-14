export default {
  searchPlaceholder: 'Search snippets by name, script or tag',
  newSnippet: 'New snippet',
  allTags: 'All',
  run: 'Run…',
  copyScript: 'Copy script',
  scriptCopied: 'Script copied to clipboard',
  duplicated: 'Snippet duplicated',
  emptyTitle: 'No snippets yet',
  emptyDescription:
    'Save the commands and scripts you use often, then run them on one or many hosts in one click — or from the snippets panel inside any terminal.',
  noMatch: 'No snippets match your search',
  clearFilters: 'Clear filters',
  lines_one: '{{count}} line',
  lines_other: '{{count}} lines',

  // editor
  newTitle: 'New snippet',
  editTitle: 'Edit snippet',
  label: 'Name',
  labelPlaceholder: 'e.g. Restart nginx',
  script: 'Script',
  scriptPlaceholder: '# Commands to run, one per line',
  scriptHint: 'Sent to the terminal as if typed: each line runs in order.',
  tags: 'Tags',
  tagsPlaceholder: 'Add a tag…',
  tagsHint: 'Press Enter or comma to add a tag.',
  removeTag: 'Remove tag {{tag}}',
  suggestions: 'Existing tags',
  saveShortcut: '{{key}} to save',
  errors: {
    label: 'Enter a name',
    script: 'The script cannot be empty',
    tooManyTags: 'A snippet can have at most {{max}} tags'
  },

  // run dialog
  runTitle: 'Run “{{name}}”',
  runDescription:
    'Choose the hosts to run this snippet on. Each host opens in a new terminal tab and runs the script once connected.',
  hosts: 'Hosts',
  hostsSearch: 'Search hosts…',
  selectedCount: '{{count}} selected',
  noHosts: 'No SSH hosts yet. Add a host first.',
  noHostsMatch: 'No matching hosts',
  runOn_one: 'Run on {{count}} host',
  runOn_other: 'Run on {{count}} hosts',
  runInCurrent: 'Run in current terminal',
  runInSession: 'Run in open session',
  openFailed: 'Could not open a session to {{name}}'
}
