import { describe, expect, it, vi } from 'vitest'

import * as VFS from '@livestore/wa-sqlite/src/VFS.js'

import { decodeAccessHandlePoolFilename } from './opfs-sah-pool.ts'

const HEADER_MAX_PATH_SIZE = 512
const HEADER_FLAGS_SIZE = 4
const HEADER_DIGEST_SIZE = 8
const HEADER_CORPUS_SIZE = HEADER_MAX_PATH_SIZE + HEADER_FLAGS_SIZE
const HEADER_OFFSET_FLAGS = HEADER_MAX_PATH_SIZE
const HEADER_OFFSET_DIGEST = HEADER_CORPUS_SIZE
const HEADER_SIZE = HEADER_OFFSET_DIGEST + HEADER_DIGEST_SIZE

describe('decodeAccessHandlePoolFilename', () => {
  it('decodes the path and digest with one file read', async () => {
    const path = '/state.db'
    const file = makeAccessHandlePoolFile(path)
    const slice = vi.spyOn(file, 'slice')

    await expect(decodeAccessHandlePoolFilename(file)).resolves.toBe(path)
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, HEADER_SIZE)
  })

  it.each([
    { label: 'an empty associated path', path: '' },
    { label: 'a 511-byte ASCII path', path: `/${'a'.repeat(510)}` },
    { label: 'a 511-byte UTF-8 path', path: `/${'é'.repeat(255)}` },
  ])('matches the two-read decoder for $label', async ({ path }) => {
    const file = makeAccessHandlePoolFile(path)

    await expect(decodeAccessHandlePoolFilename(file)).resolves.toBe(await decodeAccessHandlePoolFilenameLegacy(file))
  })

  it('rejects a corrupt digest at the digest boundary like the two-read decoder', async () => {
    const header = makeAccessHandlePoolHeader('/state.db')
    header[HEADER_OFFSET_DIGEST] = header[HEADER_OFFSET_DIGEST]! ^ 0xff
    const file = new File([header], 'opfs-pool-file')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(decodeAccessHandlePoolFilename(file)).resolves.toBe(await decodeAccessHandlePoolFilenameLegacy(file))
      await expect(decodeAccessHandlePoolFilename(file)).resolves.toBe('')
    } finally {
      warn.mockRestore()
    }
  })

  it.each([0, 4, 5])('matches the two-read decoder with %d digest bytes', async (digestBytes) => {
    const header = makeAccessHandlePoolHeader('/state.db').subarray(0, HEADER_OFFSET_DIGEST + digestBytes)
    const file = new File([header], 'opfs-pool-file')

    expect(await settle(decodeAccessHandlePoolFilename(file))).toEqual(
      await settle(decodeAccessHandlePoolFilenameLegacy(file)),
    )
  })

  it('returns on unexpected persistent flags without requiring digest bytes', async () => {
    const flags = VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_DELETEONCLOSE
    const header = makeAccessHandlePoolHeader('/state.db', flags).subarray(0, HEADER_CORPUS_SIZE)
    const file = new File([header], 'opfs-pool-file')
    const slice = vi.spyOn(file, 'slice')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(decodeAccessHandlePoolFilename(file)).resolves.toBe('')
      expect(slice).toHaveBeenCalledExactlyOnceWith(0, HEADER_SIZE)
    } finally {
      warn.mockRestore()
    }
  })
})

const makeAccessHandlePoolFile = (path: string): File =>
  new File([makeAccessHandlePoolHeader(path), new Uint8Array([0xde, 0xad, 0xbe, 0xef])], 'opfs-pool-file')

const makeAccessHandlePoolHeader = (path: string, flags: number = VFS.SQLITE_OPEN_MAIN_DB): Uint8Array<ArrayBuffer> => {
  const header = new Uint8Array(HEADER_SIZE)
  new TextEncoder().encodeInto(path, header)
  new DataView(header.buffer).setUint32(HEADER_OFFSET_FLAGS, flags)
  header.set(new Uint8Array(computeDigest(header.subarray(0, HEADER_CORPUS_SIZE)).buffer), HEADER_OFFSET_DIGEST)
  return header
}

const decodeAccessHandlePoolFilenameLegacy = async (file: File): Promise<string> => {
  const corpus = new Uint8Array(await file.slice(0, HEADER_CORPUS_SIZE).arrayBuffer())
  const flags = new DataView(corpus.buffer, corpus.byteOffset).getUint32(HEADER_OFFSET_FLAGS)
  const persistentFileTypes =
    VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_MAIN_JOURNAL | VFS.SQLITE_OPEN_SUPER_JOURNAL | VFS.SQLITE_OPEN_WAL
  if (corpus[0] !== 0 && ((flags & VFS.SQLITE_OPEN_DELETEONCLOSE) !== 0 || (flags & persistentFileTypes) === 0)) {
    return ''
  }

  const fileDigest = new Uint32Array(
    await file.slice(HEADER_OFFSET_DIGEST, HEADER_OFFSET_DIGEST + HEADER_DIGEST_SIZE).arrayBuffer(),
  )
  const computedDigest = computeDigest(corpus)
  return fileDigest.every((value, index) => value === computedDigest[index])
    ? new TextDecoder().decode(corpus.subarray(0, corpus.indexOf(0)))
    : ''
}

const settle = async (promise: Promise<string>) => {
  try {
    return { status: 'fulfilled', value: await promise } as const
  } catch (error) {
    return { status: 'rejected', error: error instanceof Error ? error.name : typeof error } as const
  }
}

const computeDigest = (corpus: Uint8Array): Uint32Array => {
  if (corpus[0] === 0) {
    return new Uint32Array([0xfe_cc_5f_80, 0xac_ce_c0_37])
  }

  let h1 = 0xde_ad_be_ef
  let h2 = 0x41_c6_ce_57

  for (const value of corpus) {
    h1 = Math.imul(h1 ^ value, 2_654_435_761)
    h2 = Math.imul(h2 ^ value, 1_597_334_677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909)

  return new Uint32Array([h1 >>> 0, h2 >>> 0])
}
