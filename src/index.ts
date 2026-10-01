import { Hono } from 'hono'

interface Env {
  BOT_TOKEN: string
  SPREADSHEET_ID: string
  CHAT_ID: string
  GOOGLE_SA_JSON_B64: string
}

const app = new Hono<{ Bindings: Env }>()

async function getAccessToken(env: Env): Promise<string> {
  const sa = JSON.parse(atob(env.GOOGLE_SA_JSON_B64))
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now
  }
  const base64url = (obj: any) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const unsigned = `${base64url(header)}.${base64url(claim)}`
  
  const key = await crypto.subtle.importKey(
    'pkcs8',
    str2ab(sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\n/g, '')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`
  
  const resp = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  })
  const data = await resp.json()
  return data.access_token
}

function str2ab(str: string) {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function sheetsGet(env: Env, range: string) {
  const token = await getAccessToken(env)
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${range}`, {
    headers: { Authorization: *** ${token}` }
  })
  const data = await resp.json()
  return data.values || []
}

async function sheetsAppend(env: Env, range: string, values: any[][]) {
  const token = await getAccessToken(env)
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    headers: { Authorization: *** ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
}

async function sendMessage(chatId: string, text: string, env: Env) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  })
}

app.post('/webhook', async (c) => {
  const env = c.env
  const update = await c.req.json()
  const msg = update.message
  if (!msg?.text) return c.text('OK')
  
  const chatId = msg.chat.id.toString()
  const text = msg.text.trim()
  const userName = msg.from?.first_name || 'Неизвестно'
  
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, `👋 <b>Родкомитет Касса Бот</b>
    
Команды:
/balance — текущий баланс
/add 5000 описание — записать приход
/spend 3000 описание — записать расход
/birthdays — ближайшие ДР`, env)
  }
  else if (text === '/balance') {
    const rows = await sheetsGet(env, 'Касса!A2:D')
    const balance = rows.reduce((sum, r) => sum + (r[1] === 'income' ? +r[2] : -+r[2]), 0)
    await sendMessage(chatId, `💰 <b>Баланс: ${balance} ₽</b>`, env)
  }
  else if (text.startsWith('/add ')) {
    const parts = text.split(' ').slice(1)
    const amount = +parts[0]
    const desc = parts.slice(1).join(' ') || 'без описания'
    const date = new Date().toISOString().slice(0, 10)
    await sheetsAppend(env, 'Касса!A:D', [[date, 'income', amount, desc]])
    await sendMessage(chatId, `✅ Приход: <b>${amount} ₽</b> — ${desc}`, env)
  }
else if (text.startsWith('/spend ')) {
    const parts = text.split(' ').slice(1)
    const amount = +parts[0]
    const desc = parts.slice(1).join(' ') || 'без описания'
    const date = new Date().toISOString().slice(0, 10)
    await sheetsAppend(env, 'Касса!A:D', [[date, 'expense', amount, desc]])
    await sendMessage(chatId, `✅ Расход: <b>${amount} ₽</b> — ${desc}`, env)
  }
  else if (text === '/birthdays') {
    const rows = await sheetsGet(env, 'ДниРождения!A2:C')
    const today = new Date()
    const upcoming = rows
      .map(r => ({ name: r[0], date: r[1], chatId: r[2] }))
      .filter(r => r.date)
      .map(r => {
        const [d, m] = r.date.split('.').map(Number)
        const bday = new Date(today.getFullYear(), m - 1, d)
        if (bday < today) bday.setFullYear(bday.getFullYear() + 1)
        return { ...r, days: Math.ceil((bday.getTime() - today.getTime()) / 86400000) }
      })
      .sort((a, b) => a.days - b.days)
      .slice(0, 10)
    if (upcoming.length === 0) {
      await sendMessage(chatId, '📅 Дни рождения не найдены', env)
    } else {
      const list = upcoming.map(r => `🎂 ${r.name} — ${r.date} (через ${r.days} дн.)`).join('\n')
      await sendMessage(chatId, `<b>Ближайшие ДР:</b>\n${list}`, env)
    }
  }
  
  return c.text('OK')
})

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (!env.CHAT_ID) return
    const rows = await sheetsGet(env, 'ДниРождения!A2:C')
    const today = new Date()
    const todayStr = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}`
    
    for (const r of rows) {
      if (r[1] === todayStr) {
        await sendMessage(env.CHAT_ID, `🎉 <b>С Днём Рождения, ${r[0]}!</b> 🎂\nРодкомитет поздравляет!`, env)
      }
    }
  }
} satisfies ExportedHandler<Env>
