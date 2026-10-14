export default {
  searchPlaceholder: 'Search rules, hosts or ports',
  newRule: 'New rule',
  rules: 'Rules',
  runningCount: '{{count}} running',
  types: {
    local: 'Local',
    remote: 'Remote',
    dynamic: 'Dynamic SOCKS'
  },
  typeHint: {
    local:
      'Opens a port on this computer. Connections to it travel through the SSH host to a destination the SSH host can reach.',
    remote:
      'Opens a port on the SSH host. Connections to it travel back through the tunnel to a destination this computer can reach.',
    dynamic: 'Runs a SOCKS5 proxy on this computer. Apps using it reach any destination through the SSH host.'
  },
  status: {
    stopped: 'Stopped',
    starting: 'Starting…',
    running: 'Running',
    error: 'Error'
  },
  connections_one: '{{count}} connection',
  connections_other: '{{count}} connections',
  autoStart: 'Auto start',
  autoStartTip: 'Starts automatically when SSH Tool launches',
  thisComputer: 'this computer',
  missingHost: 'Missing host',
  missingHostTip: 'The host used by this rule was deleted. Edit the rule to pick another host.',
  via: 'via',
  fallback: {
    local: 'Local {{bind}} → {{dest}}',
    remote: 'Remote {{bind}} → {{dest}}',
    dynamic: 'SOCKS5 proxy on {{bind}}'
  },
  start: 'Start',
  stop: 'Stop',
  startFailed: 'Could not start “{{name}}”',
  stopFailed: 'Could not stop “{{name}}”',
  duplicated: 'Rule duplicated',
  copyAddress: 'Copy listening address',
  addressCopied: 'Address copied',
  deleteMessage:
    'Delete the rule “{{name}}”? If it is running, the tunnel is stopped first. This cannot be undone.',
  emptyTitle: 'No port forwarding rules yet',
  emptyDescription:
    'Tunnel TCP traffic through your SSH hosts. Choose the kind of forwarding that fits what you want to do:',
  emptyLocal: 'Reach a service behind the SSH host — a database, an admin panel — from this computer.',
  emptyRemote: 'Expose a service running on this computer to the SSH host or its network.',
  emptyDynamic: 'Use the SSH host as a SOCKS5 proxy for your browser or other apps.',
  noMatch: 'No rules match your search',

  // editor
  newTitle: 'New port forwarding rule',
  editTitle: 'Edit port forwarding rule',
  sectionType: 'Forwarding type',
  sectionGeneral: 'General',
  sectionListenLocal: 'Listen on this computer',
  sectionListenRemote: 'Listen on the SSH host',
  sectionListenSocks: 'SOCKS proxy on this computer',
  sectionDestination: 'Destination',
  sectionOptions: 'Options',
  host: 'SSH host',
  hostPlaceholder: 'Select a host',
  hostSearch: 'Search hosts…',
  noHosts: 'No hosts yet. Add a host first.',
  noHostsMatch: 'No matching hosts',
  label: 'Label',
  labelPlaceholder: 'e.g. Production database',
  labelHint: 'Optional. Defaults to a description of the rule.',
  bindAddress: 'Bind address',
  bindPort: 'Port',
  bindHintLocal: '127.0.0.1 keeps the port private to this computer. 0.0.0.0 exposes it to your network.',
  bindHintRemote:
    '127.0.0.1 keeps the port private to the SSH host. 0.0.0.0 exposes it to its network (requires GatewayPorts on the server).',
  bindExposed: 'Other machines on the network will be able to connect to this port.',
  destHost: 'Destination host',
  destPort: 'Port',
  destHintLocal:
    'Address as seen from the SSH host, e.g. 127.0.0.1 for a service running on the SSH host itself.',
  destHintRemote: 'Address as seen from this computer, e.g. 127.0.0.1 for a service running locally.',
  autoStartLabel: 'Start automatically',
  autoStartHint: 'Start this rule whenever SSH Tool launches.',
  diagram: {
    thisComputer: 'This computer',
    sshHost: 'SSH host',
    destination: 'Destination',
    anyDestination: 'Any destination',
    tunnel: 'SSH tunnel',
    listens: 'Listens',
    selectHost: 'Not selected'
  },
  errors: {
    host: 'Select an SSH host',
    port: 'Enter a port between 1 and 65535',
    destHost: 'Enter a destination host'
  },
  restartHint: 'Running — saving restarts the tunnel',
  restarted: 'Saved and restarted',
  restartFailed: 'Saved, but the rule could not be restarted'
}
