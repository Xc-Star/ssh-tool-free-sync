export default {
  title: 'Sync',
  subtitle: 'End-to-end encrypted sync of your vault through your own database.',
  intro: {
    badge: 'Free · No account needed',
    title: 'Your hosts and keys on every device — synced through your own database',
    text: 'SSH Tool syncs your vault through a PostgreSQL, MySQL / MariaDB or Cloudflare D1 database that you control. Everything is encrypted with your master password before it leaves this device, so the database only ever stores ciphertext.',
    diagram: {
      devices: 'Your devices',
      encrypt: 'Encrypted on device',
      database: 'Your database'
    },
    features: {
      e2e: 'End-to-end encrypted',
      e2eDesc:
        'AES-256-GCM. The vault key is protected by your master password (Argon2id) and never leaves your devices unencrypted.',
      own: 'Your own database',
      ownDesc: 'PostgreSQL, MySQL / MariaDB or Cloudflare D1 — a free tier is more than enough.',
      free: 'No account, no subscription',
      freeDesc: 'Nothing to sign up for and no service in between. Free, forever.'
    },
    whatSyncs: 'What syncs',
    deviceOnly:
      'Keys can be marked “Device only” in the Keychain so they never leave this device. App settings such as theme and language stay local.'
  },
  kinds: {
    hosts: 'Hosts',
    groups: 'Groups',
    tags: 'Tags',
    keys: 'Keys',
    identities: 'Identities',
    snippets: 'Snippets',
    portForwards: 'Port forwarding rules',
    knownHosts: 'Known hosts',
    terminalPrefs: 'Terminal preferences'
  },
  platforms: {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux'
  },
  db: {
    postgres: 'PostgreSQL',
    mysql: 'MySQL / MariaDB',
    d1: 'Cloudflare D1',
    postgresDesc: 'Changes arrive instantly via LISTEN/NOTIFY. Supabase, Neon or your own server.',
    mysqlDesc: 'Any MySQL or MariaDB server, self-hosted or managed.',
    d1Desc: 'Serverless SQLite on Cloudflare’s free plan. No server to run.',
    postgresTag: 'Real-time',
    mysqlTag: 'Polling',
    d1Tag: 'Serverless'
  },
  wizard: {
    title: 'Set up sync',
    subtitle: 'Takes about two minutes. You can disconnect at any time.',
    editTitle: 'Edit connection',
    editSubtitle: 'Reconnect this device to the database, for example after its password changed.',
    stepDb: 'Choose a database',
    stepConnect: 'Connect',
    stepVault: 'Master password',
    stepCreate: 'Create your vault',
    stepJoin: 'Join your vault',
    change: 'Change',
    edit: 'Edit',
    continue: 'Continue'
  },
  form: {
    useUrl: 'Use a connection URL',
    useUrlDesc: 'Paste the URL from your provider instead of filling in the fields.',
    url: 'Connection URL',
    urlDesc: 'SSL parameters in the URL are ignored — use the SSL mode below.',
    host: 'Host',
    port: 'Port',
    database: 'Database',
    user: 'User',
    password: 'Password',
    secretSaved: 'Saved — leave empty to keep',
    optional: 'optional',
    ssl: 'SSL / TLS',
    sslModes: {
      disable: 'Disable',
      require: 'Require',
      'verify-ca': 'Verify CA',
      'verify-full': 'Verify full'
    },
    sslDesc: {
      disable: 'No encryption. Only for localhost or a trusted private network.',
      require: 'Encrypted, but the server certificate is not verified.',
      'verify-ca': 'Encrypted; the server certificate must be signed by a trusted CA.',
      'verify-full': 'Encrypted; checks the CA and that the certificate matches the host name. Most secure.'
    },
    sslRecommend: 'For databases reachable over the internet, use “Require” or stricter.',
    sslInsecure:
      'This server looks reachable over the internet. Without SSL, the database password and traffic are sent unencrypted. Use “Require” or stricter.',
    ca: 'CA certificate',
    caDesc:
      'PEM certificate of the authority that signed the server certificate. Leave empty to trust well-known public CAs.',
    caLoad: 'Load from file…',
    caFiles: 'Certificates',
    allFiles: 'All files',
    caNotPem: 'This file does not look like a PEM certificate.',
    advanced: 'Advanced',
    prefix: 'Table prefix',
    prefixDesc:
      'Tables are created with this prefix. Use a different prefix to keep separate vaults in one database.',
    accountId: 'Account ID',
    databaseId: 'Database ID',
    apiToken: 'API token',
    apiTokenDesc: 'A custom token with the permission Account → D1 → Edit.',
    baseUrl: 'API endpoint',
    baseUrlDesc:
      'Leave empty to use the Cloudflare API. Only change this for a proxy or a local test server.',
    errors: {
      required: 'Required',
      invalidPort: 'Enter a port between 1 and 65535',
      invalidUrl: 'The URL must start with {{schemes}}',
      prefixInvalid: 'Start with a letter and use only letters, digits and _ (max. 31)',
      invalidBaseUrl: 'Enter an http(s) URL'
    },
    warnings: {
      accountId: 'Account IDs are usually 32 hexadecimal characters.',
      databaseId: 'Database IDs usually look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'
    }
  },
  test: {
    button: 'Test connection',
    testing: 'Connecting…',
    ok: 'Connected in {{ms}} ms',
    vaultFound: 'This database already contains an encrypted vault — join it with its master password.',
    noVault: 'The database is ready. There is no vault yet, so you will create one.',
    vaultFoundShort: 'Vault found',
    noVaultShort: 'No vault yet',
    failed: 'Could not connect',
    unknownError: 'Unknown error',
    hints: {
      network:
        'Check the host name and port, and that the database accepts connections from this computer (firewall, allowed IP addresses).',
      auth: 'Check the user name and password — or, for Cloudflare D1, the API token and its D1 Edit permission.',
      tls: 'There is a problem with the TLS certificate. Provide the CA certificate, or choose “Require” to encrypt without verifying it.',
      noSsl:
        'The server does not accept encrypted connections. For a local or private server you can set SSL to “Disable”.',
      database: 'Check the database name — or, for Cloudflare D1, the Account ID and Database ID.'
    }
  },
  vault: {
    createDesc:
      'Choose a master password. It protects the key that encrypts your vault, and you need it to connect your other devices.',
    joinDesc:
      'Enter the master password of this vault. The hosts, keys and snippets on this device are merged into it — nothing is deleted.',
    editCreateNote:
      'This database has no vault yet. A new vault will be created from the data on this device; connect your other devices to this database afterwards.',
    masterPassword: 'Master password',
    confirm: 'Confirm master password',
    strengthLabel: 'Strength',
    strength: {
      tooShort: 'Too short',
      weak: 'Weak',
      fair: 'Fair',
      good: 'Good',
      strong: 'Strong'
    },
    minLength: 'At least 8 characters',
    mismatch: 'The passwords do not match',
    match: 'Passwords match',
    ack: 'I understand that the master password cannot be recovered.',
    ackDesc: 'If I forget it, my synced data cannot be decrypted — by anyone.',
    ackRequired: 'Please confirm to continue.',
    create: 'Create vault and start syncing',
    join: 'Join vault',
    creating: 'Creating your vault…',
    joining: 'Joining your vault…',
    progress:
      'Deriving the encryption key (Argon2id), encrypting your data and uploading it. This can take a few seconds.',
    elapsed: '{{s}} s',
    wrongPassword: 'Wrong master password',
    vaultExists: 'Another device created a vault in the meantime. Test the connection again to join it.',
    noVaultNow: 'The vault no longer exists in this database. Test the connection again.',
    testAgain: 'Test again',
    doneTitle: 'Sync is on',
    doneCreated: 'Your vault was created and this device is now syncing.',
    doneJoined: 'This device joined your vault and is now in sync.',
    nextTitle: 'Add your other devices',
    next1: 'Install SSH Tool on the other device and open Settings → Sync.',
    next2: 'Choose the same database and enter the same connection details.',
    next3: 'Enter your master password to join the vault.',
    done: 'Go to sync status'
  },
  help: {
    sqlTitle: 'Where do I get a database?',
    sql1: 'Any PostgreSQL, MySQL or MariaDB database works: a free hosted PostgreSQL such as Supabase or Neon, a managed database from your cloud provider, or your own server.',
    sql2: 'Create a database (for example “sshtool”) and a user with <b>CREATE TABLE, SELECT, INSERT, UPDATE and DELETE</b> privileges on it. SSH Tool creates its tables automatically.',
    sql3: 'The database only ever receives encrypted data, so even a hosted database never sees your hosts, passwords or keys.',
    selfHosted: 'Self-hosted',
    d1Title: 'How to set up Cloudflare D1',
    d1Step1:
      'Create a D1 database in the Cloudflare dashboard: <b>Workers & Pages → D1 SQL Database → Create</b>. Or with the Wrangler CLI:',
    d1Step2:
      'Create an API token: <b>My Profile → API Tokens → Create Token → Create Custom Token</b>, and add the permission <b>Account → D1 → Edit</b>.',
    d1Step3:
      '<b>Account ID</b>: the 32-character ID in the dashboard URL (<code>dash.cloudflare.com/ACCOUNT_ID/…</code>), also shown in the sidebar of the account home page. <b>Database ID</b>: shown on the page of your D1 database.',
    d1Warning:
      'A token with D1 Edit permission can read and change every D1 database in the account. Consider a dedicated Cloudflare account for SSH Tool.',
    openTokens: 'Open API tokens',
    openDocs: 'D1 documentation',
    copy: 'Copy',
    copied: 'Copied'
  },
  dashboard: {
    states: {
      idle: 'Up to date',
      syncing: 'Syncing…',
      offline: 'Offline',
      error: 'Sync error',
      'needs-password': 'Master password needed',
      disabled: 'Sync is off'
    },
    stateDesc: {
      idle: 'All changes are synced across your devices.',
      syncing: 'Exchanging encrypted changes with the database…',
      offline: 'The database cannot be reached right now. SSH Tool keeps retrying automatically.',
      error: 'Syncing stopped because of an error.',
      'needs-password': 'Syncing is paused until you enter the master password.',
      disabled: 'This device is not syncing.'
    },
    syncNow: 'Sync now',
    disconnect: 'Disconnect',
    lastSync: 'Last sync',
    never: 'Never',
    pending: 'Pending',
    pendingSub: 'local changes',
    updates: 'Updates',
    realtime: 'Real-time',
    realtimeSub: 'LISTEN/NOTIFY',
    polling: 'Polling',
    pollingSub: 'every {{count}} s',
    reconcile: 'Full check',
    reconcileEvery: 'Every {{count}} min',
    reconcileSub: 'consistency check',
    synced: 'Everything is up to date',
    syncFailed: 'Sync failed',
    errorHint: {
      offline:
        'SSH Tool retries automatically. Check your internet connection and whether the database is reachable.',
      error:
        'Try “Sync now”. If the problem persists, check the connection or disconnect and set up sync again.'
    },
    disconnectTitle: 'Disconnect sync?',
    disconnectMessage:
      'This device stops syncing. Your data stays on this device and nothing is deleted from the database, so you can reconnect later with your master password.',
    disconnected: 'Sync disconnected',
    unlockTitle: 'Enter your master password',
    unlockDesc:
      'The vault key was changed on another device (key rotation). Enter the master password to download the new key and resume syncing.',
    unlock: 'Unlock',
    unlocked: 'Syncing resumed',
    devices: 'Devices',
    devicesDesc: 'Devices connected to this vault.',
    refresh: 'Refresh',
    thisDevice: 'This device',
    noDevices: 'No devices have reported yet.',
    devicesError: 'Could not load the device list',
    unknownPlatform: 'Unknown platform',
    unknownDevice: 'Unknown device',
    unknownDeviceHint: 'Details unavailable (encrypted with an older vault key)',
    lastSeen: 'Last seen {{time}}',
    connection: 'Connection',
    url: 'Connection URL',
    server: 'Server',
    databaseName: 'Database',
    user: 'User',
    ssl: 'SSL / TLS',
    customCa: 'Custom CA',
    unencrypted: 'Unencrypted',
    prefix: 'Table prefix',
    accountId: 'Account ID',
    databaseId: 'Database ID',
    apiToken: 'API token',
    endpoint: 'API endpoint',
    test: 'Test',
    editConnection: 'Edit…',
    intervals: 'Intervals',
    poll: 'Check for changes every',
    pollDesc: 'How often the database is asked for changes from other devices (5–3600 s).',
    pollDescRealtime: 'PostgreSQL pushes changes instantly; polling is only a fallback (5–3600 s).',
    reconcileLabel: 'Full consistency check every',
    reconcileDesc: 'Compares everything with the database to repair missed changes (1–1440 min).',
    secondsShort: 's',
    minutesShort: 'min',
    intervalsSaved: 'Intervals saved',
    security: 'Security',
    changePassword: 'Change master password',
    changePasswordDesc:
      'Re-encrypts the vault key with a new master password. Your devices keep syncing; use the new password to add devices.',
    changeBtn: 'Change…',
    rotateKey: 'Rotate vault key',
    rotateKeyDesc: 'Generates a new vault key and re-encrypts everything — locks out lost or stolen devices.',
    rotateBtn: 'Rotate…',
    changeTitle: 'Change master password',
    currentPassword: 'Current master password',
    newPassword: 'New master password',
    confirmNew: 'Confirm new master password',
    passwordChanged: 'Master password changed',
    rotateTitle: 'Rotate vault key',
    rotate1: 'A new random vault key is generated; all items are re-encrypted with it and uploaded again.',
    rotate2:
      'Devices that do not know the master password lose access — use this if a device was lost or stolen.',
    rotate3: 'Your other devices will ask for the master password once.',
    rotateConfirm: 'Rotate key',
    rotating: 'Re-encrypting and uploading…',
    rotated: 'Vault key rotated',
    openKeychain: 'Open Keychain'
  }
}
