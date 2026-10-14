import { StringDecoder } from 'node:string_decoder'
import iconv from 'iconv-lite'

export interface TextCodec {
  decode(buf: Buffer): string
  encode(text: string): Buffer
}

/** Stateful decoder/encoder for terminal I/O (multi-byte sequences may be split across chunks). */
export function makeCodec(charset: string | undefined): TextCodec {
  const cs = (charset || 'utf-8').toLowerCase()
  if (cs === 'utf-8' || cs === 'utf8' || !iconv.encodingExists(cs)) {
    const dec = new StringDecoder('utf8')
    return { decode: (b) => dec.write(b), encode: (t) => Buffer.from(t, 'utf8') }
  }
  const dec = iconv.getDecoder(cs)
  return { decode: (b) => dec.write(b), encode: (t) => iconv.encode(t, cs) }
}

export const SUPPORTED_CHARSETS = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'iso-8859-15',
  'windows-1251',
  'windows-1252',
  'koi8-r'
]
