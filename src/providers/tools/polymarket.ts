/**
 * Polymarket prediction market search tool.
 *
 * Searches Polymarket events and markets via the Gamma API.
 * Free, public, no auth required. Rate limit: 350 req/10s.
 *
 * Uses /public-search for keyword queries (powers the Polymarket search bar).
 * Outcomes and prices are JSON-encoded strings that must be parsed.
 *
 * API docs: https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles
 */
import { keptJson, keptText } from "../http.js"
import { free, outcome } from "../outcome.js"

interface PolymarketMarket {
  id: string
  question: string
  description?: string
  outcomes: string // JSON-encoded: '["Yes","No"]'
  outcomePrices: string // JSON-encoded: '["0.20","0.80"]'
  volume?: string
  volumeNum?: number
  volume24hr?: number
  volume1wk?: number
  volume1mo?: number
  liquidity?: string
  liquidityNum?: number
  endDate?: string
  closed: boolean
  active: boolean
  slug?: string
  oneDayPriceChange?: number
  oneWeekPriceChange?: number
  oneMonthPriceChange?: number
  bestBid?: number
  bestAsk?: number
  spread?: number
}

interface PolymarketEvent {
  id: string
  title: string
  slug: string
  description?: string
  markets: PolymarketMarket[]
  volume?: number
  volume24hr?: number
  liquidity?: number
  competitive?: number
  startDate?: string
  endDate?: string
  active?: boolean
  closed?: boolean
  tags?: Array<{ label?: string; slug?: string }>
}

interface PublicSearchResponse {
  events?: PolymarketEvent[]
  tags?: Array<{ id: string; label: string; slug: string; event_count?: number }>
  pagination?: { hasMore?: boolean; totalResults?: number }
}

/** Search Polymarket prediction markets. Keyless and free. */
export default free({
  description:
    "Search Polymarket prediction markets for real-money odds on any topic. " +
    "Uses the Gamma /public-search API (free, no auth, 350 req/10s). " +
    "Returns events with nested markets showing probabilities, volume, liquidity, and price movement. " +
    "Best for elections, geopolitics, tech milestones, sports, crypto, and any topic " +
    "where people are betting real money on outcomes. " +
    "Outcomes/prices are parsed from JSON-encoded strings automatically.",
  async execute(args, context) {
    context.abort.throwIfAborted()
    const limit = Math.min(args.limit ?? 10, 30)
    const page = args.page ?? 1

    // Expand queries: search the main query + individual significant words
    // This catches markets where the topic is an outcome, not just a title keyword
    const queries = expandQueries(args.query)

    try {
      // Run all query expansions, deduplicating by event ID
      const allEvents = new Map<string, PolymarketEvent>()

      for (const q of queries) {
        const url =
          `https://gamma-api.polymarket.com/public-search?` +
          `q=${encodeURIComponent(q)}` +
          `&page=${page}` +
          `&events_status=active` +
          `&keep_closed_markets=0`

        const response = await fetch(url, {
          signal: context.abort,
          headers: { "User-Agent": "opencode-polymarket-tool/1.0" },
        })

        if (!response.ok) {
          await keptText(response, context.keep, `search ${q}`).catch(() => "")
          // Don't fail on expansion queries, just skip
          if (q === args.query) {
            return `ERROR: Polymarket API returned ${response.status}: ${response.statusText}`
          }
          continue
        }

        context.abort.throwIfAborted()
        const data = (await keptJson(response, context.keep, `search ${q}`)) as PublicSearchResponse
        // events can be null/undefined per the OpenAPI spec, not just empty array
        for (const event of data.events ?? []) {
          if (!allEvents.has(event.id)) {
            allEvents.set(event.id, event)
          }
        }
      }

      const events = Array.from(allEvents.values())

      if (events.length === 0) {
        return outcome("empty", `No Polymarket events found for "${args.query}".`)
      }

      // Score and rank events
      const queryLower = args.query.toLowerCase()
      const queryTokens: Set<string> = new Set(queryLower.split(/\s+/).filter((t: string) => t.length > 2))

      const scored = events
        .filter((e) => !e.closed && e.active !== false)
        .map((event) => {
          const markets = (event.markets || []).filter((m) => m.active && !m.closed)
          if (markets.length === 0) return null

          // Text relevance: title match + outcome-aware matching
          const titleLower = event.title.toLowerCase()
          let textScore = titleLower.includes(queryLower)
            ? 1.0
            : tokenOverlap(queryTokens, titleLower)

          // Outcome-aware: check if query matches individual market outcomes or questions
          const matchedOutcomes: { market: string; label: string; price: number }[] = []
          for (const market of markets) {
            const outcomes = safeJsonParse<string[]>(market.outcomes, [])
            const prices = safeJsonParse<string[]>(market.outcomePrices, [])

            for (let i = 0; i < outcomes.length; i++) {
              const outcome = outcomes[i]
              if (!outcome) continue
              const outcomeLower = outcome.toLowerCase()
              if (
                outcomeLower.includes(queryLower) ||
                queryLower.includes(outcomeLower) ||
                tokenOverlap(queryTokens, outcomeLower) > 0.6
              ) {
                // Skip generic "Yes"/"No" matches — only match named outcomes
                if (outcomeLower === "yes" || outcomeLower === "no") continue
                textScore = Math.max(textScore, 0.85)
                matchedOutcomes.push({
                  market: market.question,
                  label: outcome,
                  price: parseFloat(prices[i] || "0"),
                })
              }
            }

            // Also check the market question itself (for neg-risk binary events)
            if (market.question !== event.title) {
              const qLower = market.question.toLowerCase()
              if (qLower.includes(queryLower) || tokenOverlap(queryTokens, qLower) > 0.5) {
                textScore = Math.max(textScore, 0.75)
              }
            }
          }

          // Market quality: volume + liquidity + movement
          const topMarket = markets[0]!
          const vol24h = event.volume24hr || topMarket.volume24hr || 0
          const volTotal = event.volume || topMarket.volumeNum || 0
          const liq = event.liquidity || topMarket.liquidityNum || 0
          const volScore = Math.min(1.0, Math.log1p(vol24h) / 14) // ~$1.2M = 1.0
          const liqScore = Math.min(1.0, Math.log1p(liq) / 14)

          // Price movement: recent changes indicate live, newsworthy markets
          const dayChange = Math.abs(topMarket.oneDayPriceChange || 0) * 3
          const weekChange = Math.abs(topMarket.oneWeekPriceChange || 0) * 2
          const monthChange = Math.abs(topMarket.oneMonthPriceChange || 0)
          const movementScore = Math.min(1.0, Math.max(dayChange, weekChange, monthChange) * 5)

          // Competitive bonus: markets near 50/50 are more interesting
          const competitive = event.competitive || 0

          const marketQuality =
            0.50 * volScore + 0.25 * liqScore + 0.15 * movementScore + 0.10 * competitive

          // Final relevance: text dominates, market quality refines
          const relevance = Math.min(1.0, textScore * (0.75 + 0.25 * marketQuality))

          return { event, markets, relevance, matchedOutcomes, topMarket, vol24h, volTotal }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)

      scored.sort((a, b) => b.relevance - a.relevance)
      const topEvents = scored.slice(0, limit)

      // Format results
      const results = topEvents.map(({ event, markets, matchedOutcomes, topMarket, vol24h, volTotal }) => {
        const lines: string[] = []

        lines.push(`**${event.title}**`)
        lines.push(
          `  Volume: $${formatNumber(volTotal)} total` +
            (vol24h ? ` | $${formatNumber(vol24h)} 24h` : "") +
            (event.endDate ? ` | Ends: ${event.endDate.split("T")[0]}` : "")
        )

        if (event.slug) {
          lines.push(`  URL: https://polymarket.com/event/${event.slug}`)
        }

        // Price movement on top market
        const movement = formatPriceMovement(topMarket)
        if (movement) {
          lines.push(`  Movement: ${movement}`)
        }

        // Matched outcomes (query appeared as an outcome in a multi-outcome market)
        if (matchedOutcomes.length > 0) {
          lines.push(`  Matched outcomes:`)
          for (const mo of matchedOutcomes) {
            lines.push(`    → ${mo.label}: ${(mo.price * 100).toFixed(1)}% — "${mo.market}"`)
          }
        }

        // Show markets with odds
        // For events with many binary sub-markets (neg-risk), synthesize into a leaderboard
        const allBinary = markets.every((m) => {
          const outcomes = safeJsonParse<string[]>(m.outcomes, [])
          return outcomes.length === 2 && outcomes.map((o) => o.toLowerCase()).includes("yes")
        })

        if (allBinary && markets.length > 1) {
          // Synthesize: show each market's "Yes" price as the entity's probability
          const leaderboard = markets
            .map((m) => {
              const prices = safeJsonParse<string[]>(m.outcomePrices, [])
              const outcomes = safeJsonParse<string[]>(m.outcomes, [])
              const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes")
              const yesPrice = yesIdx >= 0 ? parseFloat(prices[yesIdx] || "0") : 0
              return { question: shortenQuestion(m.question), price: yesPrice }
            })
            .filter((x) => x.price > 0.005)
            .sort((a, b) => b.price - a.price)

          lines.push(`  Odds:`)
          for (const item of leaderboard.slice(0, 8)) {
            lines.push(`    ${item.question}: ${(item.price * 100).toFixed(1)}%`)
          }
          if (leaderboard.length > 8) {
            lines.push(`    ... +${leaderboard.length - 8} more`)
          }
        } else {
          // Show individual markets with full outcome odds
          for (const market of markets.slice(0, 3)) {
            const outcomes = safeJsonParse<string[]>(market.outcomes, [])
            const prices = safeJsonParse<string[]>(market.outcomePrices, [])

            if (outcomes.length <= 2) {
              const oddsStr = outcomes
                .map((o, i) => `${o}: ${(parseFloat(prices[i] || "0") * 100).toFixed(1)}%`)
                .join(" / ")
              lines.push(`  📊 ${market.question} — ${oddsStr}`)
            } else {
              const pairs = outcomes
                .map((o, i) => ({ label: o, price: parseFloat(prices[i] || "0") }))
                .sort((a, b) => b.price - a.price)
              lines.push(`  📊 ${market.question}`)
              for (const p of pairs.slice(0, 5)) {
                lines.push(`    ${p.label}: ${(p.price * 100).toFixed(1)}%`)
              }
              if (pairs.length > 5) {
                lines.push(`    ... +${pairs.length - 5} more outcomes`)
              }
            }
          }
          if (markets.length > 3) {
            lines.push(`  ... +${markets.length - 3} more markets`)
          }
        }

        return lines.join("\n")
      })

      const header = [
        `Polymarket results for "${args.query}" (${topEvents.length} events, ${queries.length} query expansions):`,
        "",
      ].join("\n")

      return header + results.join("\n\n")
    } catch (err) {
      context.abort.throwIfAborted()
      return `ERROR: Failed to search Polymarket: ${err instanceof Error ? err.message : "Unknown error"}`
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand a query into multiple search terms to cast a wider net */
function expandQueries(query: string): string[] {
  const queries = [query]
  const words = query.split(/\s+/).filter((w) => w.length > 2)

  // Add individual significant words (skipping low-signal tokens)
  const lowSignal = new Set([
    "the", "and", "for", "with", "that", "this", "from", "will", "what",
    "how", "who", "when", "best", "top", "new", "latest", "odds", "prediction",
  ])
  if (words.length >= 2) {
    for (const word of words) {
      if (!lowSignal.has(word.toLowerCase())) {
        queries.push(word)
      }
    }
  }

  // Dedupe, cap at 5
  const seen = new Set<string>()
  return queries.filter((q) => {
    const key = q.toLowerCase().trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 5)
}

/** Token overlap relevance between query tokens and a text string */
function tokenOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0
  const textTokens: Set<string> = new Set(text.toLowerCase().split(/\s+/))
  let matches = 0
  Array.from(queryTokens).forEach((token) => {
    if (textTokens.has(token)) matches++
  })
  return matches / queryTokens.size
}

/** Safely parse a JSON-encoded string (outcomes/prices are stored as strings in the API) */
function safeJsonParse<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback
  try {
    if (typeof value === "object") return value as T // Already parsed
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Extract a short display name from a market question */
function shortenQuestion(question: string): string {
  const q = question.trim().replace(/\?$/, "")
  // "Will Arizona win the 2026 NCAA Tournament?" → "Arizona"
  const match = q.match(
    /^Will\s+(.+?)\s+(?:win|be|make|reach|have|lose|qualify|advance|strike|agree|pass|sign|get|become|remain|stay|leave|survive)\b/i
  )
  if (match && match[1]) return match[1].trim()
  // Shorter fallback
  const m2 = q.match(/^Will\s+(.+?)\s+/i)
  if (m2 && m2[1] && m2[1].split(" ").length <= 4) return m2[1].trim()
  return question.length > 40 ? question.slice(0, 40) + "…" : question
}

/** Format the most significant price change for a market */
function formatPriceMovement(market: PolymarketMarket): string | null {
  const changes: [number, number, string][] = [
    [Math.abs(market.oneDayPriceChange || 0), market.oneDayPriceChange || 0, "today"],
    [Math.abs(market.oneWeekPriceChange || 0), market.oneWeekPriceChange || 0, "this week"],
    [Math.abs(market.oneMonthPriceChange || 0), market.oneMonthPriceChange || 0, "this month"],
  ]
  changes.sort((a, b) => b[0] - a[0])
  const top = changes[0]
  if (!top || top[0] < 0.01) return null // Less than 1% = noise
  const [absChange, rawChange, period] = top
  const direction = rawChange > 0 ? "↑" : "↓"
  return `${direction} ${(absChange * 100).toFixed(1)}% ${period}`
}

/** Format large numbers for readability */
function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}
