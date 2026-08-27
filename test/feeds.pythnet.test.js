import { describe, it, expect } from 'vitest'
import { feedIdToAccount, parsePriceAccount } from '../src/feeds/pythnet.js'

/**
 * Pure-parse tests only — no network. The live read and the stale-account
 * refusal are exercised against the real chain by scripts/verify-pythnet.mjs,
 * because both need a real RPC to mean anything.
 */

const XAU_FEED = '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2'
const XAG_FEED = '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e'

/** Minimal but layout-accurate Pyth V2 price account. */
function priceAccount({
  expo = -3,
  status = 1,
  aggPrice = 4601161n,
  aggConf = 491n,
  tsSec = 1787865000,
  prevPrice = 4590000n,
  prevConf = 400n,
  prevTsSec = 1787860000,
  magic = 0xa1b2c3d4,
  version = 2,
  accountType = 3,
} = {}) {
  const b = Buffer.alloc(512)
  b.writeUInt32LE(magic, 0)
  b.writeUInt32LE(version, 4)
  b.writeUInt32LE(accountType, 8)
  b.writeInt32LE(expo, 20)
  b.writeBigInt64LE(BigInt(tsSec), 96)
  b.writeBigInt64LE(prevPrice, 184)
  b.writeBigUInt64LE(prevConf, 192)
  b.writeBigInt64LE(BigInt(prevTsSec), 200)
  b.writeBigInt64LE(aggPrice, 208)
  b.writeBigUInt64LE(aggConf, 216)
  b.writeUInt32LE(status, 224)
  return b
}

describe('feedIdToAccount', () => {
  it('maps a Pyth feed id to its known Pythnet account address', () => {
    // Verified against a live getAccountInfo on 2026-08-27.
    expect(feedIdToAccount(XAU_FEED)).toBe('8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axafSsBX5FcD')
    expect(feedIdToAccount(XAG_FEED)).toBe('HMVfAm6uuwnPnHRzaqfMhLNyrYHxaczKTbzeDcjBvuDo')
  })

  it('accepts an id with or without the 0x prefix', () => {
    expect(feedIdToAccount(XAU_FEED)).toBe(feedIdToAccount(XAU_FEED.slice(2)))
  })

  it('rejects an id that is not 32 bytes', () => {
    expect(() => feedIdToAccount('0xdeadbeef')).toThrow(/32 bytes/)
  })
})

describe('parsePriceAccount', () => {
  it('applies the exponent to price and confidence', () => {
    const p = parsePriceAccount(priceAccount())
    expect(p.price).toBeCloseTo(4601.161, 6)
    expect(p.confidence).toBeCloseTo(0.491, 6)
    expect(p.trading).toBe(true)
  })

  it('uses prev_* when the aggregate is not Trading', () => {
    // Metals stop trading 17:00-18:00 ET and all weekend. `agg` still holds a
    // number there, but its status says not to trust it — prev_* is the last
    // aggregate that WAS trading, and its own timestamp must ride with it.
    const p = parsePriceAccount(priceAccount({ status: 0 }))
    expect(p.trading).toBe(false)
    expect(p.price).toBeCloseTo(4590.0, 6)
    expect(p.publishTimeMs).toBe(1787860000 * 1000)
  })

  it('carries the on-chain timestamp, not wall clock', () => {
    const p = parsePriceAccount(priceAccount({ tsSec: 1787865000 }))
    expect(p.publishTimeMs).toBe(1787865000 * 1000)
  })

  // The guards below are what stop a wrong or abandoned account being decoded
  // into a plausible price. Solana mainnet-beta holds the SAME addresses with a
  // 728-day-old price (XAU $2,423 against a live $4,601) — structurally valid,
  // so only an age check catches it, and only these guards catch a layout change.
  it('rejects a buffer with the wrong magic', () => {
    expect(() => parsePriceAccount(priceAccount({ magic: 0xdeadbeef }))).toThrow(/bad magic/)
  })

  it('rejects an unsupported account version', () => {
    expect(() => parsePriceAccount(priceAccount({ version: 3 }))).toThrow(/version 3/)
  })

  it('rejects a non-price account type', () => {
    expect(() => parsePriceAccount(priceAccount({ accountType: 2 }))).toThrow(/account type 2/)
  })

  it('rejects a zeroed buffer rather than reporting price 0', () => {
    expect(() => parsePriceAccount(Buffer.alloc(512))).toThrow(/bad magic/)
  })

  it('rejects a truncated account', () => {
    expect(() => parsePriceAccount(Buffer.alloc(100))).toThrow(/too short/)
  })

  it('rejects a non-positive price', () => {
    expect(() => parsePriceAccount(priceAccount({ aggPrice: 0n }))).toThrow(/non-positive/)
  })
})
