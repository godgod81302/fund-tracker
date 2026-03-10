import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { scrapeAllFunds, scrapeFundDetails } from './scraper/fundScraper'
import { mockFunds, mockPortfolios, mockNavHistory, mockPerformanceData } from './mockData'
import * as iconv from 'iconv-lite'
import * as portfolioService from './services/portfolioService'
import * as backtestService from './services/backtestService'

type Bindings = {
  DB: D1Database
}

// 計算同類型排名（基於夏普值和年化報酬）
async function calculateRankings(db: D1Database) {
  try {
    const { results: fundTypes } = await db.prepare(
      `SELECT DISTINCT fund_type FROM funds WHERE fund_type IS NOT NULL`
    ).all()
    
    for (const { fund_type } of fundTypes as any[]) {
      const { results: sharpeRanked } = await db.prepare(
        `SELECT id FROM funds 
         WHERE fund_type = ? AND sharpe_ratio IS NOT NULL 
         ORDER BY sharpe_ratio DESC`
      ).bind(fund_type).all()
      
      for (let i = 0; i < (sharpeRanked as any[]).length; i++) {
        const fund = (sharpeRanked as any[])[i]
        await db.prepare(
          `UPDATE funds SET sharpe_ranking = ? WHERE id = ?`
        ).bind(i + 1, fund.id).run()
      }
      
      const { results: returnRanked } = await db.prepare(
        `SELECT id FROM funds 
         WHERE fund_type = ? AND annual_return IS NOT NULL 
         ORDER BY annual_return DESC`
      ).bind(fund_type).all()
      
      for (let i = 0; i < (returnRanked as any[]).length; i++) {
        const fund = (returnRanked as any[])[i]
        await db.prepare(
          `UPDATE funds SET annual_return_ranking = ? WHERE id = ?`
        ).bind(i + 1, fund.id).run()
      }
    }
    
    console.log('Rankings calculated for all fund types')
  } catch (error) {
    console.error('Error calculating rankings:', error)
  }
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

app.get('/', (c) => {
  return c.json({ message: '3A基金監測 API', version: '1.0.0' })
})

app.get('/api/funds', async (c) => {
  const db = c.env.DB
  const { results } = await db.prepare(`
    SELECT 
      f.id,
      f.code,
      f.name,
      f.fund_type as fundType,
      f.currency,
      f.risk_level as riskLevel,
      f.current_nav as currentNav,
      f.dividend_yield as dividendYield,
      f.dividend_frequency as dividendFrequency,
      f.is_suspended as isSuspended,
      f.established_date as establishedDate,
      f.fund_size as totalAssets,
      f.rating,
      f.annual_return as yearReturn,
      f.sharpe_ratio as sharpeRatio,
      f.three_year_return as threeYearReturn,
      f.beta,
      f.standard_deviation as standardDeviation
    FROM funds f
    ORDER BY f.code
  `).all()
  
  return c.json({ data: results })
})

app.get('/api/funds/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  
  const fund = await db.prepare(`
    SELECT 
      f.*,
      fp.annual_return as yearReturn,
      fp.sharpe_ratio as sharpeRatio,
      fp.ranking
    FROM funds f
    LEFT JOIN fund_performance fp ON f.id = fp.fund_id
    WHERE f.id = ? OR f.code = ?
  `).bind(id, id).first()
  
  if (!fund) {
    return c.json({ error: 'Fund not found' }, 404)
  }
  
  return c.json({ data: fund })
})

app.get('/api/funds/:id/nav-history', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  
  const { results } = await db.prepare(`
    SELECT fnh.date, fnh.nav
    FROM fund_nav_history fnh
    JOIN funds f ON fnh.fund_id = f.id
    WHERE f.id = ? OR f.code = ?
    ORDER BY fnh.date DESC
    LIMIT 365
  `).bind(id, id).all()
  
  return c.json({ data: results })
})

app.get('/api/funds/:id/performance', async (c) => {
  return c.json({ data: mockPerformanceData })
})

app.get('/api/portfolios', async (c) => {
  try {
    const portfolios = await portfolioService.getAllPortfolios(c.env.DB)
    return c.json({ data: portfolios })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/portfolios', async (c) => {
  try {
    const body = await c.req.json()
    const { name, description } = body
    
    if (!name) {
      return c.json({ error: 'Name is required' }, 400)
    }
    
    const portfolio = await portfolioService.createPortfolio(c.env.DB, name, description)
    return c.json(portfolio)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/portfolios/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const summary = await portfolioService.getPortfolioSummary(c.env.DB, id)
    
    if (!summary) {
      return c.json({ error: 'Portfolio not found' }, 404)
    }
    
    return c.json(summary)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.delete('/api/portfolios/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    await portfolioService.deletePortfolio(c.env.DB, id)
    return c.json({ message: 'Portfolio deleted' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/portfolios/:id/holdings', async (c) => {
  try {
    const portfolioId = parseInt(c.req.param('id'))
    const body = await c.req.json()
    const { fund_code, shares, buy_price, buy_date } = body
    
    if (!fund_code || !shares || !buy_price || !buy_date) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    
    await portfolioService.addHoldingToPortfolio(
      c.env.DB,
      portfolioId,
      fund_code,
      parseFloat(shares),
      parseFloat(buy_price),
      buy_date
    )
    
    return c.json({ message: 'Holding added successfully' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/portfolios/holdings/:id/sell', async (c) => {
  try {
    const holdingId = parseInt(c.req.param('id'))
    const body = await c.req.json()
    const { shares, sell_price, sell_date } = body
    
    if (!shares || !sell_price || !sell_date) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    
    await portfolioService.sellHolding(
      c.env.DB,
      holdingId,
      parseFloat(shares),
      parseFloat(sell_price),
      sell_date
    )
    
    return c.json({ message: 'Holding sold successfully' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/portfolios/:id/transactions', async (c) => {
  try {
    const portfolioId = parseInt(c.req.param('id'))
    const transactions = await portfolioService.getTransactionHistory(c.env.DB, portfolioId)
    return c.json({ data: transactions })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/portfolios/:id/snapshot', async (c) => {
  try {
    const portfolioId = parseInt(c.req.param('id'))
    const body = await c.req.json()
    const { date } = body
    
    await portfolioService.createPortfolioSnapshot(
      c.env.DB,
      portfolioId,
      date || new Date().toISOString().split('T')[0]
    )
    
    return c.json({ message: 'Snapshot created' })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/portfolios/:id/history', async (c) => {
  try {
    const portfolioId = parseInt(c.req.param('id'))
    const startDate = c.req.query('start_date')
    const endDate = c.req.query('end_date')
    
    const history = await portfolioService.getPortfolioHistory(
      c.env.DB,
      portfolioId,
      startDate,
      endDate
    )
    
    return c.json({ data: history })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/backtest', async (c) => {
  try {
    const config = await c.req.json()
    
    if (!config.start_date || !config.end_date || !config.initial_investment) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    
    const result = await backtestService.runBacktest(c.env.DB, config)
    return c.json(result)
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/backtest/compare', async (c) => {
  try {
    const body = await c.req.json()
    const { comparisons, start_date, end_date, initial_investment } = body
    
    if (!comparisons || !start_date || !end_date || !initial_investment) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    
    const results = await backtestService.compareBacktest(
      c.env.DB,
      comparisons,
      start_date,
      end_date,
      initial_investment
    )
    
    return c.json({ data: results })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/test-scrape', async (c) => {
  try {
    const jsonUrl = 'https://invest.fubonlife.com.tw/w/custom/djjson/SearchProductJSON.djjson?P1=fubonlif&P2=False&P3=False&P4=0&P5=0&m=0&Change=1'
    const response = await fetch(jsonUrl)
    const text = await response.text()
    const data = JSON.parse(text)
    
    return c.json({ 
      status: response.status,
      contentType: response.headers.get('content-type'),
      dataLength: data?.ResultSet?.DataLength || 0,
      sampleFunds: data?.ResultSet?.Result?.slice(0, 3) || []
    })
  } catch (error) {
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/test-details', async (c) => {
  try {
    const fullCode = c.req.query('code') || 'JFZN3-JFP11'
    const raw = c.req.query('raw') === 'true'
    
    if (raw) {
      // 返回原始 HTML 用於調試
      const url = `https://invest.fubonlife.com.tw/w/wb/wb01.djhtm?a=${fullCode}`
      const response = await fetch(url)
      const buffer = await response.arrayBuffer()
      const decoder = new TextDecoder('utf-8', { fatal: false })
      let text = decoder.decode(buffer)
      text = text.replace(/\uFFFD/g, '_')
      
      return c.text(text.substring(0, 15000)) // 返回前15000字符
    }
    
    const { scrapeFundDetails } = await import('./scraper/fundScraper')
    
    // 從 fullCode 提取 code（通常是最後一個 '-' 之後的部分）
    // JFZN3-JFP11 -> JFP11, ACYT02-YT01 -> YT01
    const code = fullCode.split('-').pop() || fullCode
    
    console.log(`Testing details scraping for: ${fullCode} (code: ${code})`)
    const details = await scrapeFundDetails(fullCode, code)
    
    return c.json({ fullCode, code, details })
  } catch (error) {
    console.error('Test details error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

// 優先爬取用戶追蹤的基金
app.get('/api/scrape/priority', async (c) => {
  try {
    const db = c.env.DB
    
    // 查詢所有用戶持有的基金代碼（去重）
    const holdings = await db.prepare(`
      SELECT DISTINCT f.code, f.name, f.currency, f.annual_return, f.updated_at
      FROM portfolio_holdings ph
      JOIN funds f ON ph.fund_id = f.id
      ORDER BY f.updated_at ASC NULLS FIRST
    `).all()
    
    const priorityFunds = holdings.results || []
    
    if (priorityFunds.length === 0) {
      return c.json({ 
        message: 'No priority funds to scrape',
        count: 0,
        inserted: 0
      })
    }
    
    console.log(`Priority scraping ${priorityFunds.length} user-tracked funds`)
    
    let updated = 0
    const batchSize = 8
    
    // 分批處理優先基金
    for (let i = 0; i < priorityFunds.length; i += batchSize) {
      const batch = priorityFunds.slice(i, i + batchSize)
      console.log(`Processing priority batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(priorityFunds.length/batchSize)}`)
      
      for (const fund of batch) {
        try {
          const { scrapeFundDetails } = await import('./scraper/fundScraper')
          
          // 使用 code 作為 fullCode（需要從 JSON API 獲取完整 V40）
          const details = await scrapeFundDetails(fund.code as string, fund.code as string, fund.currency as string)
          
          if (details.fundInfo || details.performance) {
            await db.prepare(`
              UPDATE funds 
              SET manager = ?,
                  rating = ?,
                  sharpe_ratio = ?,
                  annual_return = ?,
                  three_year_return = ?,
                  established_date = ?,
                  fund_size = ?,
                  beta = ?,
                  standard_deviation = ?,
                  ytd_return = ?,
                  updated_at = datetime('now')
              WHERE code = ?
            `).bind(
              details.fundInfo?.manager || null,
              details.fundInfo?.rating || null,
              details.performance?.sharpeRatio || null,
              details.performance?.yearReturn || null,
              details.performance?.threeYearReturn || null,
              details.fundInfo?.establishedDate || null,
              details.fundInfo?.fundSize || null,
              details.performance?.beta || null,
              details.performance?.standardDeviation || null,
              details.performance?.ytdReturn || null,
              fund.code
            ).run()
            
            updated++
          }
        } catch (error) {
          console.error(`Error updating priority fund ${fund.code}:`, error)
        }
      }
      
      // 批次間延遲避免過載
      if (i + batchSize < priorityFunds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    
    return c.json({
      message: 'Priority scraping completed',
      totalFunds: priorityFunds.length,
      updated
    })
  } catch (error) {
    console.error('Priority scraping error:', error)
    return c.json({ error: String(error) }, 500)
  }
})

app.get('/api/scrape', async (c) => {
  try {
    const db = c.env.DB
    const batchIndexParam = c.req.query('batch')
    let batchIndex = batchIndexParam ? parseInt(batchIndexParam) : undefined
    const batchSize = 8  // 限制為 8 檔避免超過 Worker 50 個子請求限制
    
    // 如果沒有指定批次，自動找下一個未完成的批次
    if (batchIndex === undefined) {
      const nextBatch = await db.prepare(`
        SELECT batch_index FROM batch_status 
        WHERE status IN ('pending', 'failed') 
        ORDER BY batch_index ASC 
        LIMIT 1
      `).first() as { batch_index: number } | null
      
      if (!nextBatch) {
        return c.json({ message: 'All batches completed', allCompleted: true })
      }
      batchIndex = nextBatch.batch_index
    }
    
    console.log(`Manual scrape triggered, batch: ${batchIndex}`)
    
    // 標記批次為處理中
    await db.prepare(`
      UPDATE batch_status 
      SET status = 'processing', started_at = datetime('now'), last_updated = datetime('now')
      WHERE batch_index = ?
    `).bind(batchIndex).run()
    
    const funds = await scrapeAllFunds(batchIndex, batchSize)
    
    let inserted = 0
    let failed = 0
    const failedFunds: string[] = []
    
    for (const fund of funds) {
      try {
      // 插入基金基本資料
      await db.prepare(
        `INSERT OR REPLACE INTO funds 
         (code, name, currency, risk_level, fund_type, dividend_frequency, dividend_yield, current_nav, 
          is_suspended, manager, rating, sharpe_ratio, annual_return, three_year_return, established_date, fund_size,
          beta, standard_deviation, ytd_return, one_month_return, three_month_return, six_month_return,
          two_year_return, five_year_return, ten_year_return, investment_region_text, fund_company,
          management_fee, benchmark_index, custody_fee, sales_fee, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        fund.code || '',
        fund.name || '',
        fund.currency || '台幣',
        fund.riskLevel || 'RR3',
        fund.fundType || '股票型',
        fund.dividendFrequency || '',
        fund.dividendYield || 0,
        fund.currentNav || 0,
        fund.isSuspended ? 1 : 0,
        fund.manager || null,
        (fund as any).rating || null,
        fund.sharpeRatio || null,
        fund.yearReturn || null,
        fund.threeYearReturn || null,
        fund.establishedDate || null,
        fund.totalAssets || null,
        (fund as any).beta || null,
        (fund as any).standardDeviation || null,
        (fund as any).ytdReturn || null,
        (fund as any).oneMonthReturn || null,
        (fund as any).threeMonthReturn || null,
        (fund as any).sixMonthReturn || null,
        (fund as any).twoYearReturn || null,
        (fund as any).fiveYearReturn || null,
        (fund as any).tenYearReturn || null,
        (fund as any).investmentRegionText || null,
        (fund as any).fundCompany || null,
        (fund as any).managementFee || null,
        (fund as any).benchmarkIndex || null,
        (fund as any).custodyFee || null,
        (fund as any).salesFee || null
      ).run()
      
      // 插入/更新持股資訊（投資區域、產業）
      if ((fund as any).investmentRegion || (fund as any).investmentIndustry) {
        await db.prepare(
          `INSERT OR REPLACE INTO fund_holdings 
           (fund_id, investment_region, investment_industry, updated_at)
           SELECT id, ?, ?, datetime('now') FROM funds WHERE code = ?`
        ).bind(
          (fund as any).investmentRegion || null,
          (fund as any).investmentIndustry || null,
          fund.code
        ).run()
      }
      
      inserted++
      } catch (fundError) {
        failed++
        failedFunds.push(fund.code || 'unknown')
        console.error(`Failed to insert fund ${fund.code}:`, fundError)
        // 繼續處理下一個基金
      }
    }
    console.log(`Inserted ${inserted} funds, failed ${failed} funds`)
    if (failedFunds.length > 0) {
      console.log(`Failed funds: ${failedFunds.join(', ')}`)
    }
    
    // 計算同類型排名（基於夏普值和年化報酬）
    try {
      await calculateRankings(db)
    } catch (rankError) {
      console.error('Ranking calculation failed:', rankError)
      // 不影響主流程
    }
    
    // 更新批次狀態
    const batchStatus = failed > 0 ? 'failed' : 'completed'
    await db.prepare(`
      UPDATE batch_status 
      SET status = ?, 
          total_funds = ?,
          inserted_funds = ?,
          failed_funds = ?,
          failed_fund_codes = ?,
          completed_at = datetime('now'),
          last_updated = datetime('now')
      WHERE batch_index = ?
    `).bind(
      batchStatus,
      funds.length,
      inserted,
      failed,
      failedFunds.join(','),
      batchIndex
    ).run()
    
    return c.json({ 
      message: 'Scraping completed',
      batch: batchIndex,
      count: funds.length,
      inserted,
      failed,
      failedFunds 
    })
  } catch (error) {
    console.error('Scraping error:', error)
    
    // 記錄批次失敗
    if (batchIndex !== undefined && c.env.DB) {
      try {
        await c.env.DB.prepare(`
          UPDATE batch_status 
          SET status = 'failed',
              error_message = ?,
              retry_count = retry_count + 1,
              last_updated = datetime('now')
          WHERE batch_index = ?
        `).bind(String(error), batchIndex).run()
      } catch (updateError) {
        console.error('Failed to update batch status:', updateError)
      }
    }
    
    return c.json({ error: String(error) }, 500)
  }
})

app.post('/api/scrape', async (c) => {
  try {
    const db = c.env.DB
    const funds = await scrapeAllFunds()
    
    for (const fund of funds) {
      await db.prepare(
        `INSERT OR REPLACE INTO funds 
         (code, name, currency, risk_level, fund_type, dividend_frequency, dividend_yield, current_nav, is_suspended, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        fund.code,
        fund.name,
        fund.currency,
        fund.riskLevel,
        fund.fundType,
        fund.dividendFrequency,
        fund.dividendYield,
        fund.currentNav,
        fund.isSuspended ? 1 : 0
      ).run()
    }
    
    return c.json({ message: 'Scraping completed', count: funds.length })
  } catch (error) {
    console.error('Scraping error:', error)
    return c.json({ error: 'Scraping failed' }, 500)
  }
})

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    return app.fetch(request, env)
  },
  
  async scheduled(event: ScheduledEvent, env: Bindings): Promise<void> {
    console.log('Cron trigger fired at:', new Date(event.scheduledTime).toISOString())
    
    try {
      const batchSize = 8
      
      // 首先檢查並重置超時的 processing 批次（超過 5 分鐘視為超時）
      const timeoutMinutes = 5
      const timeoutResult = await env.DB.prepare(`
        UPDATE batch_status 
        SET status = 'failed',
            error_message = 'Worker timeout - exceeded 5 minutes',
            retry_count = retry_count + 1,
            last_updated = datetime('now')
        WHERE status = 'processing' 
          AND datetime(started_at, '+5 minutes') < datetime('now')
      `).run()
      
      if (timeoutResult.meta.changes > 0) {
        console.log(`Reset ${timeoutResult.meta.changes} timeout batches to failed`)
      }
      
      // 從 batch_status 表找下一個未完成的批次（斷點繼續）
      let nextBatch = await env.DB.prepare(`
        SELECT batch_index FROM batch_status 
        WHERE status IN ('pending', 'failed') 
        ORDER BY batch_index ASC 
        LIMIT 1
      `).first() as { batch_index: number } | null
      
      if (!nextBatch) {
        // 檢查是否所有批次都已完成
        const stats = await env.DB.prepare(`
          SELECT COUNT(*) as total, 
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                 SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
                 SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
          FROM batch_status
        `).first() as { total: number, completed: number, processing: number, failed: number } | null
        
        console.log(`Batch stats: completed=${stats?.completed}, processing=${stats?.processing}, failed=${stats?.failed}, total=${stats?.total}`)
        
        // 如果有 processing 批次，不應該重置（可能是超時檢測還沒執行）
        if (stats && stats.processing > 0) {
          console.log('有批次正在處理中，等待下次 Cron')
          return
        }
        
        if (stats && stats.completed === stats.total) {
          // 所有批次都完成了，重置開始新一輪循環更新
          console.log('All batches completed, resetting for next cycle...')
          await env.DB.prepare(`
            UPDATE batch_status 
            SET status = 'pending', 
                started_at = NULL, 
                completed_at = NULL,
                total_funds = 0,
                inserted_funds = 0,
                failed_funds = 0,
                failed_fund_codes = NULL,
                error_message = NULL,
                last_updated = datetime('now')
          `).run()
          
          // 重新查找第一個批次
          nextBatch = await env.DB.prepare(`
            SELECT batch_index FROM batch_status 
            WHERE status = 'pending' 
            ORDER BY batch_index ASC 
            LIMIT 1
          `).first() as { batch_index: number } | null
          
          console.log('Reset complete, starting new cycle from batch 0')
        } else {
          console.log(`No pending/failed batches found. Stats: ${stats?.failed} failed, ${stats?.completed}/${stats?.total} completed`)
          return
        }
      }
      
      if (!nextBatch) {
        console.log('No batches available to process')
        return
      }
      
      const batchIndex = nextBatch.batch_index
      console.log(`Processing batch ${batchIndex} (auto-resume from batch_status)`)
      
      // 標記批次為處理中
      await env.DB.prepare(`
        UPDATE batch_status 
        SET status = 'processing', started_at = datetime('now'), last_updated = datetime('now')
        WHERE batch_index = ?
      `).bind(batchIndex).run()
      
      // 爬取這批基金
      const funds = await scrapeAllFunds(batchIndex, batchSize)
      
      if (funds.length === 0) {
        console.log(`Batch ${batchIndex} returned no funds`)
        await env.DB.prepare(`
          UPDATE batch_status 
          SET status = 'failed', error_message = 'No funds returned', last_updated = datetime('now')
          WHERE batch_index = ?
        `).bind(batchIndex).run()
        return
      }
      
      console.log(`Processing batch ${batchIndex}: ${funds.length} funds`)
      
      let inserted = 0
      let failed = 0
      const failedFunds: string[] = []
      
      // 處理這批基金（帶錯誤容錯）
      for (const fund of funds) {
        try {
          // 插入基金基本資料
          await env.DB.prepare(
          `INSERT OR REPLACE INTO funds 
           (code, name, currency, risk_level, fund_type, dividend_frequency, dividend_yield, current_nav, 
            is_suspended, manager, rating, sharpe_ratio, annual_return, three_year_return, established_date, fund_size,
            beta, standard_deviation, ytd_return, one_month_return, three_month_return, six_month_return,
            two_year_return, five_year_return, ten_year_return, investment_region_text, fund_company,
            management_fee, benchmark_index, custody_fee, sales_fee, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind(
            fund.code || '',
            fund.name || '',
            fund.currency || '台幣',
            fund.riskLevel || 'RR3',
            fund.fundType || '股票型',
            fund.dividendFrequency || '',
            fund.dividendYield || 0,
            fund.currentNav || 0,
            fund.isSuspended ? 1 : 0,
            fund.manager || null,
            (fund as any).rating || null,
            fund.sharpeRatio || null,
            fund.yearReturn || null,
            fund.threeYearReturn || null,
            fund.establishedDate || null,
            fund.totalAssets || null,
            (fund as any).beta || null,
            (fund as any).standardDeviation || null,
            (fund as any).ytdReturn || null,
            (fund as any).oneMonthReturn || null,
            (fund as any).threeMonthReturn || null,
            (fund as any).sixMonthReturn || null,
            (fund as any).twoYearReturn || null,
            (fund as any).fiveYearReturn || null,
            (fund as any).tenYearReturn || null,
            (fund as any).investmentRegionText || null,
            (fund as any).fundCompany || null,
            (fund as any).managementFee || null,
            (fund as any).benchmarkIndex || null,
            (fund as any).custodyFee || null,
            (fund as any).salesFee || null
          ).run()
          
          // 插入/更新持股資訊
          if ((fund as any).investmentRegion || (fund as any).investmentIndustry) {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO fund_holdings 
               (fund_id, investment_region, investment_industry, updated_at)
               SELECT id, ?, ?, datetime('now') FROM funds WHERE code = ?`
            ).bind(
              (fund as any).investmentRegion || null,
              (fund as any).investmentIndustry || null,
              fund.code
            ).run()
          }
          
          inserted++
          
          if (fund.currentNav) {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO fund_nav_history (fund_id, date, nav) 
               SELECT id, date('now'), ? FROM funds WHERE code = ?`
            ).bind(fund.currentNav, fund.code).run()
          }
        } catch (fundError) {
          failed++
          failedFunds.push(fund.code || 'unknown')
          console.error(`Failed to insert fund ${fund.code}:`, fundError)
        }
      }
      
      console.log(`Batch ${batchIndex} completed: inserted ${inserted}, failed ${failed}`)
      
      // 計算同類型排名
      try {
        await calculateRankings(env.DB)
        console.log('Rankings calculated')
      } catch (rankError) {
        console.error('Ranking calculation failed:', rankError)
      }
      
      // 更新批次狀態
      const batchStatus = failed > 0 ? 'failed' : 'completed'
      await env.DB.prepare(`
        UPDATE batch_status 
        SET status = ?, 
            total_funds = ?,
            inserted_funds = ?,
            failed_funds = ?,
            failed_fund_codes = ?,
            completed_at = datetime('now'),
            last_updated = datetime('now')
        WHERE batch_index = ?
      `).bind(
        batchStatus,
        funds.length,
        inserted,
        failed,
        failedFunds.join(','),
        batchIndex
      ).run()
      
      console.log(`Cron job completed: batch ${batchIndex}, status: ${batchStatus}`)
    } catch (error) {
      console.error('Scheduled scraping error:', error)
      
      // 記錄批次失敗
      try {
        const failedBatch = await env.DB.prepare(`
          SELECT batch_index FROM batch_status 
          WHERE status = 'processing' 
          ORDER BY started_at DESC 
          LIMIT 1
        `).first() as { batch_index: number } | null
        
        if (failedBatch) {
          await env.DB.prepare(`
            UPDATE batch_status 
            SET status = 'failed',
                error_message = ?,
                retry_count = retry_count + 1,
                last_updated = datetime('now')
            WHERE batch_index = ?
          `).bind(String(error), failedBatch.batch_index).run()
        }
      } catch (updateError) {
        console.error('Failed to update batch status:', updateError)
      }
    }
  }
}

