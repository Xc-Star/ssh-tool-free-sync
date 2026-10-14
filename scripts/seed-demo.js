// Seeds demo vault data for screenshots: node scripts/shot.mjs --eval "$(cat scripts/seed-demo.js)" ...
;(async () => {
  const inv = async (m, ...a) => {
    const r = await window.sshtool.invoke(m, ...a)
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  const prod = await inv('vault.upsert', 'group', { name: 'Production', username: 'deploy' })
  const stage = await inv('vault.upsert', 'group', { name: 'Staging' })
  await inv('vault.upsert', 'group', { name: 'Databases', parentId: prod.id })
  const web = await inv('vault.upsert', 'tag', { name: 'web' })
  const db = await inv('vault.upsert', 'tag', { name: 'db' })
  await inv('vault.upsert', 'host', { label: 'Bastion', address: 'bastion.example.com', username: 'ops', osHint: 'debian' })
  await inv('vault.upsert', 'host', { label: 'Home NAS', address: '192.168.1.20', username: 'admin', osHint: 'synology' })
  await inv('vault.upsert', 'host', { label: 'Raspberry Pi', address: '192.168.1.42', username: 'pi', osHint: 'raspbian' })
  await inv('vault.upsert', 'host', { label: 'web-01', address: '10.0.1.11', groupId: prod.id, tagIds: [web.id], osHint: 'ubuntu' })
  await inv('vault.upsert', 'host', { label: 'web-02', address: '10.0.1.12', groupId: prod.id, tagIds: [web.id], osHint: 'ubuntu' })
  await inv('vault.upsert', 'host', { label: 'pg-main', address: '10.0.2.5', groupId: prod.id, tagIds: [db.id], osHint: 'rocky' })
  await inv('vault.upsert', 'host', { label: 'stage-app', address: 'stage.example.com', groupId: stage.id, osHint: 'alpine', username: 'root' })
  await inv('vault.upsert', 'host', { label: 'Router', address: '192.168.1.1', telnetEnabled: true, sshEnabled: false })
  await inv('keys.generate', { label: 'Work laptop', type: 'ed25519' })
  await inv('vault.upsert', 'identity', { label: 'Ops account', username: 'ops', password: 'secret' })
  await inv('vault.upsert', 'snippet', { label: 'Disk usage', script: 'df -h', tags: ['monitoring'] })
  await inv('vault.upsert', 'snippet', { label: 'Update system', script: 'sudo apt update && sudo apt upgrade -y', tags: ['maintenance'] })
})()
