import { describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@shared/schemas'
import type { WebdavDbConfig } from '@shared/types'
import {
  buildConfig,
  DB_KINDS,
  describeTarget,
  emptyD1Form,
  emptySqlForm,
  emptyWebdavForm,
  errorHint,
  validateForm,
  webdavFormFrom
} from '../../src/renderer/src/features/sync/model'

const webdavConfig: WebdavDbConfig = {
  kind: 'webdav',
  url: 'https://cloud.example.com/remote.php/dav/files/me/sshtool/',
  username: 'me',
  password: 'app-password',
  tablePrefix: 'sshtool_'
}

describe('sync model: WebDAV', () => {
  it('offers WebDAV as a selectable backend', () => {
    expect(DB_KINDS).toContain('webdav')
  })

  it('round-trips a stored WebDAV config through the form', () => {
    const form = webdavFormFrom(webdavConfig)
    expect(form).toEqual({
      url: webdavConfig.url,
      username: 'me',
      password: 'app-password',
      tablePrefix: 'sshtool_'
    })
    expect(buildConfig('webdav', emptySqlForm(), emptyD1Form(), form)).toEqual(webdavConfig)
  })

  it('keeps the stored secret when the password field is left masked', () => {
    const form = { ...webdavFormFrom(webdavConfig), password: SECRET_MASK }
    const cfg = buildConfig('webdav', emptySqlForm(), emptyD1Form(), form)
    expect(cfg.kind).toBe('webdav')
    if (cfg.kind !== 'webdav') throw new Error('expected a WebDAV config')
    expect(cfg.password).toBe(SECRET_MASK)
  })

  it('omits an empty user name and password', () => {
    const cfg = buildConfig('webdav', emptySqlForm(), emptyD1Form(), emptyWebdavForm())
    expect(cfg).toEqual({ kind: 'webdav', url: '', username: undefined, password: undefined, tablePrefix: 'sshtool_' })
  })

  it('validates the folder URL and the file prefix', () => {
    expect(validateForm('webdav', emptySqlForm(), emptyD1Form(), emptyWebdavForm())).toEqual({ url: 'required' })
    const bad = { ...emptyWebdavForm(), url: 'cloud.example.com/dav', tablePrefix: '1bad' }
    expect(validateForm('webdav', emptySqlForm(), emptyD1Form(), bad)).toEqual({
      url: 'invalidBaseUrl',
      tablePrefix: 'prefixInvalid'
    })
    const good = { ...emptyWebdavForm(), url: 'https://cloud.example.com/dav/x' }
    expect(validateForm('webdav', emptySqlForm(), emptyD1Form(), good)).toEqual({})
  })

  it('describes the target without leaking credentials', () => {
    expect(describeTarget(webdavConfig)).toBe('cloud.example.com/remote.php/dav/files/me/sshtool')
    expect(describeTarget({ ...webdavConfig, url: 'https://me:pw@cloud.example.com/dav/x/' })).toBe(
      'cloud.example.com/dav/x'
    )
    expect(describeTarget({ ...webdavConfig, url: 'not a url' })).toBe('not a url')
  })

  it('maps connection failures to actionable hints', () => {
    expect(errorHint('The WebDAV server rejected the credentials (HTTP 401).')).toBe('auth')
    expect(errorHint('The WebDAV folder was not found (HTTP 404). Check the URL.')).toBe('database')
    expect(errorHint('Cannot reach the WebDAV server: ECONNREFUSED')).toBe('network')
    expect(errorHint('There is a problem with the TLS certificate.')).toBe('tls')
  })
})
