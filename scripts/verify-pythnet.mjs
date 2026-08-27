const M=new URL('../src/feeds/pythnet.js', import.meta.url).href
const { fetchPythnetPrice, feedIdToAccount, parsePriceAccount } = await import(M)
let fails = 0
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++ }

// 1. feed id -> account address
ok(feedIdToAccount('0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2')
   === '8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axafSsBX5FcD', 'XAU feed id -> known Pythnet account')

// 2. live reads
const xau = await fetchPythnetPrice('XAU/USD','0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2')
const xag = await fetchPythnetPrice('XAG/USD','0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e')
console.log(`  XAU ${xau.price.toFixed(2)} ±${xau.confidence.toFixed(2)} trading=${xau.trading} age=${((Date.now()-xau.publishTimeMs)/1000).toFixed(0)}s`)
console.log(`  XAG ${xag.price.toFixed(4)} ±${xag.confidence.toFixed(4)} trading=${xag.trading} age=${((Date.now()-xag.publishTimeMs)/1000).toFixed(0)}s`)
ok(xau.price > 3000 && xau.price < 7000, 'XAU in a sane range')
ok(xag.price > 30 && xag.price < 150, 'XAG in a sane range')
ok(Date.now()-xau.publishTimeMs < 24*3600e3, 'XAU on-chain timestamp is recent')

// 3. cross-check against an independent free source
const g = await (await fetch('https://api.gold-api.com/price/XAU')).json()
const drift = Math.abs(xau.price - g.price)/g.price*100
ok(drift < 0.5, `XAU within 0.5% of an independent source (${drift.toFixed(3)}%)`)

// 4. THE TRAP: the same account on Solana mainnet is ~728 days stale. The age
//    gate must refuse it rather than publishing a structurally-valid $2,423 gold.
process.env.PYTHNET_RPC_URLS = 'https://api.mainnet-beta.solana.com'
const stale = await import(M + '?trap=1')
let refused = false
try { await stale.fetchPythnetPrice('XAU/USD','0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2') }
catch (e) { refused = /abandoned account|d old/.test(e.message) }
ok(refused, 'REFUSES the 728-day-stale mainnet-beta copy of the same account')

// 5. malformed input fails loud
let threw = false
try { parsePriceAccount(Buffer.alloc(300)) } catch { threw = true }
ok(threw, 'rejects a zeroed buffer (magic guard)')

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
