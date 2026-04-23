'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const Parser     = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const rss  = new Parser({ timeout: 6000 });

/* ─── CACHE mémoire (TTL configurable) ─────────────────────── */
const store = new Map();
function cGet(k) {
  const e = store.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { store.delete(k); return null; }
  return e.v;
}
function cSet(k, v, ttl = 300000) { store.set(k, { v, exp: Date.now() + ttl }); }
setInterval(() => { const now = Date.now(); for (const [k,v] of store) if (now > v.exp) store.delete(k); }, 60000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ─── CLIENT GEMINI ─────────────────────────────────────────── */
let gemini = null;
let geminiModel = null;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (GEMINI_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  geminiModel = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',          // rapide + généreux en tokens gratuits
    generationConfig: {
      temperature: 0.3,                  // déterministe pour les JSON
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',  // force la réponse en JSON pur
    },
  });
  gemini = true;
}

/* ══════════════════════════════════════════════════════════════
   ROUTE  /api/company  — recherche via OpenCorporates
══════════════════════════════════════════════════════════════ */
const SECTORS = [
  [/tech|software|saas|digital|ia\b|ai\b|logiciel/i,  'Tech / SaaS'],
  [/bio|med|pharma|health|santé|clinic/i,              'Santé / Medtech'],
  [/logis|transport|freight|cargo|livrai/i,            'Logistique / Transport'],
  [/energy|énergie|solar|renew|green|clean/i,          'Energie / Cleantech'],
  [/auto|motor|vehicle|automobil/i,                    'Automobile'],
  [/aero|aéro|defense|défense|aviat/i,                 'Aéronautique / Défense'],
  [/food|aliment|agro|boulang|fromagerie/i,            'Agroalimentaire'],
  [/cosmet|beauté|parfum|soin/i,                       'Cosmétique / Bien-être'],
  [/mode|fashion|text|vêtement|cloth/i,                'Mode / Textile'],
  [/construct|btp|bâtiment|immobil/i,                  'Construction / BTP'],
  [/chimi|material|matériau|plastic/i,                 'Chimie / Matériaux'],
  [/industri|manufactur|usine|machin/i,                'Industrie / Manufacturing'],
];
const gSector = n => { for (const [re, l] of SECTORS) if (re.test(n)) return l; return 'Services B2B'; };

app.get('/api/company', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name || name.length < 2)
    return res.status(400).json({ error: 'Paramètre "name" requis (min 2 caractères).' });

  const ck = 'co:' + name.toLowerCase();
  const cached = cGet(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const params = new URLSearchParams({ q: name, format: 'json', per_page: '8' });
    if (process.env.OPENCORPORATES_API_KEY) params.set('api_token', process.env.OPENCORPORATES_API_KEY);

    const r = await axios.get(`https://api.opencorporates.com/v0.4/companies/search?${params}`, {
      timeout: 7000,
      headers: { 'User-Agent': 'Xpansio/1.0' },
    });

    const raw = r.data?.results?.companies || [];
    const results = raw.map(({ company: c }) => ({
      name:         c.name || '',
      jurisdiction: c.jurisdiction_code || '',
      company_type: c.company_type || '',
      status:       c.current_status || '',
      registered_at:c.incorporation_date || null,
      oc_url:       c.opencorporates_url || '',
      sector_guess: gSector(c.name || ''),
    }));

    const payload = { query: name, total: r.data?.results?.total_count || results.length, results, fromCache: false };
    cSet(ck, payload, 10 * 60000);
    return res.json(payload);
  } catch (err) {
    if (err.response?.status === 503 || err.response?.status === 429)
      return res.status(503).json({ error: 'OpenCorporates temporairement indisponible.', results: [], total: 0 });
    if (err.code === 'ECONNABORTED')
      return res.status(504).json({ error: 'Timeout OpenCorporates.', results: [], total: 0 });
    return res.status(500).json({ error: 'Erreur recherche : ' + err.message, results: [], total: 0 });
  }
});

/* ══════════════════════════════════════════════════════════════
   ROUTE  /api/news  — NewsAPI + fallback RSS
══════════════════════════════════════════════════════════════ */
const TRADE_KW = ['export','import','trade','tariff','commerce','douane','accord','sanction','marché','market','économi','growth','croissance','wto','omc','géopoliti','investissement','inflation'];
const RSS_FEEDS = [
  { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters Business' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC Business' },
  { url: 'https://www.lesechos.fr/rss/rss_une.xml',        source: 'Les Echos' },
  { url: 'https://www.lemonde.fr/economie/rss_full.xml',   source: 'Le Monde Économie' },
];

function gTopic(t) {
  const l = (t || '').toLowerCase();
  if (/tariff|douane|taxe|duty/.test(l))          return 'Tensions douanières';
  if (/accord|agreement|deal|traité/.test(l))     return 'Accord commercial';
  if (/export|import/.test(l))                    return 'Exportations';
  if (/géopoliti|sanction|conflit/.test(l))       return 'Géopolitique';
  if (/growth|gdp|croissance|inflation/.test(l))  return 'Économie mondiale';
  return 'Commerce international';
}
function sHtml(s = '') {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
}

app.get('/api/news', async (req, res) => {
  const lang  = req.query.lang  || 'fr';
  const limit = Math.min(parseInt(req.query.limit || '12', 10), 30);
  const ck    = 'news:' + lang;
  const cached = cGet(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  let articles = [], source = '';

  /* 1 — NewsAPI */
  if (process.env.NEWS_API_KEY) {
    try {
      const r = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          apiKey:   process.env.NEWS_API_KEY,
          q:        'commerce international OR export tariffs OR trade sanctions OR géopolitique économique',
          language: lang === 'fr' ? 'fr' : 'en',
          sortBy:   'publishedAt',
          pageSize: 20,
        },
        timeout: 7000,
      });
      if (r.data.status === 'ok') {
        articles = (r.data.articles || [])
          .filter(a => a.title && a.title !== '[Removed]')
          .map(a => ({ title: a.title, excerpt: (a.description || '').slice(0, 200), source: a.source?.name || 'NewsAPI', date: a.publishedAt, url: a.url, topic: gTopic(a.title + ' ' + (a.description || '')) }));
        source = 'NewsAPI';
      }
    } catch (_) { /* continue to RSS */ }
  }

  /* 2 — RSS fallback */
  if (!articles.length) {
    try {
      const fetched = await Promise.allSettled(RSS_FEEDS.map(async f => {
        const p = await rss.parseURL(f.url);
        return (p.items || []).map(i => ({
          title:   i.title?.trim() || '',
          excerpt: sHtml(i.contentSnippet || i.content || '').slice(0, 200),
          source:  f.source,
          date:    i.pubDate || i.isoDate || null,
          url:     i.link || '#',
          topic:   gTopic((i.title || '') + ' ' + (i.contentSnippet || '')),
        }));
      }));
      for (const r of fetched) if (r.status === 'fulfilled') articles.push(...r.value);
      articles = articles.filter(a => TRADE_KW.some(k => a.title.toLowerCase().includes(k) || a.excerpt.toLowerCase().includes(k)));
      source = 'RSS';
    } catch (_) {
      return res.status(503).json({ error: 'Sources d\'actualités indisponibles.', articles: [], total: 0 });
    }
  }

  /* Déduplication + tri */
  const seen = new Set();
  const deduped = articles
    .filter(a => { const k = a.title.slice(0, 50).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, limit);

  const payload = { articles: deduped, total: deduped.length, source, fromCache: false };
  cSet(ck, payload, 10 * 60000);
  return res.json(payload);
});

/* ══════════════════════════════════════════════════════════════
   ROUTE  /api/analyze  — Gemini 1.5 Flash
══════════════════════════════════════════════════════════════ */

/* Construction du prompt */
function buildPrompt(ctx, countries, news) {
  const newsBlock = news && news.length
    ? '\n\nACTUALITÉS RÉCENTES DU COMMERCE INTERNATIONAL (utilise-les pour contextualiser) :\n'
      + news.slice(0, 6).map(a => `- [${a.topic}] ${a.title}`).join('\n')
    : '';

  return `Tu es un expert senior en développement commercial international et analyse de marchés export pour PME.

PROFIL DE L'ENTREPRISE :
- Nom : ${ctx.name || 'Non précisé'}
- Secteur : ${ctx.sector}
- Produit / service : ${ctx.product || 'Non précisé'}
- CA annuel : ${ctx.revenue || 'Non précisé'}
- Employés : ${ctx.employees || 'Non précisé'}
- Équipe allouée à l'export : ${ctx.team || 'Non précisé'} personnes
- Budget export : ${ctx.budget || 'Non précisé'}
- Part export actuelle : ${ctx.export_pct || 'Non précisée'}
- Pays déjà actifs : ${ctx.active || 'Aucun'}
- Objectif : ${ctx.goal || 'Non précisé'}
- Horizon : ${ctx.horizon || 'Non précisé'}
- Cible CA export : ${ctx.target || 'Non précisé'}
- KPIs : ${ctx.kpis || 'Non précisés'}
- Contexte / atouts : ${ctx.context || 'Aucun'}
${newsBlock}

PAYS À ANALYSER : ${countries.join(', ')}

Pour chaque pays, fournis une analyse experte tenant compte du contexte économique actuel, des spécificités culturelles business, des opportunités sectorielles et des risques géopolitiques récents.

Réponds UNIQUEMENT avec cet objet JSON (pas de markdown, pas de texte avant ou après) :
{
  "summary": "2 phrases synthèse identifiant les marchés les plus prometteurs",
  "countries": [
    {
      "country": "nom exact du pays",
      "score": 72,
      "verdict": "Atteignable",
      "market_size": "Élevé",
      "ease_entry": "Moyenne",
      "competition": "Élevée",
      "cultural_fit": "Élevée",
      "political_risk": "Faible",
      "economic_context": "1 phrase sur la conjoncture économique actuelle pour ce secteur",
      "cultural_insight": "1 phrase sur les spécificités culturelles business clés",
      "key_opportunity": "1 phrase sur l'opportunité principale pour cette PME",
      "main_risk": "1 phrase sur le risque principal",
      "financials": {
        "entry_invest": "50 000–100 000 €",
        "yr1_revenue": "150 000–300 000 €",
        "yr3_revenue": "500 000–900 000 €",
        "breakeven": "12–18 mois",
        "note": "Estimation basée sur le secteur ${ctx.sector || 'général'}"
      },
      "strategy": {
        "title": "Titre stratégie en 3-4 mots",
        "description": "2-3 phrases concrètes : canal recommandé, type de partenariat, première action à mener le premier mois"
      }
    }
  ]
}

RÈGLES STRICTES :
- score : entier entre 0 et 100, calibré sur les ressources réelles de cette PME
- verdict : exactement un mot parmi : Prioritaire | Atteignable | Prometteur | À surveiller | Risqué | Difficile | Déconseillé
- strategy : mettre null (pas de guillemets) si score < 55
- financials : toujours présent, avec des estimations réalistes pour ce secteur et ce pays
- Réponds UNIQUEMENT avec le JSON — aucun texte avant, aucun texte après`;
}

/* Extraction robuste du JSON depuis la réponse Gemini */
function extractJSON(text) {
  // Gemini avec responseMimeType:'application/json' retourne du JSON pur
  // Mais on sécurise au cas où il y aurait du texte autour
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    if (p && Array.isArray(p.countries)) return p;
  } catch (_) {}

  // Fallback : cherche manuellement le premier objet JSON avec "countries"
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const p = JSON.parse(text.slice(start, i + 1));
          if (p && Array.isArray(p.countries)) return p;
        } catch (_) {}
        start = -1;
      }
    }
  }
  return null;
}

/* Placeholder pour un pays qui a échoué */
function makePlaceholder(country, reason) {
  return {
    country, score: 0, verdict: 'Non analysé',
    market_size: '—', ease_entry: '—', competition: '—', cultural_fit: '—', political_risk: '—',
    economic_context: 'Analyse temporairement indisponible : ' + reason,
    cultural_insight: '', key_opportunity: '', main_risk: '',
    financials: null, strategy: null, _error: true,
  };
}

const BATCH_SIZE = 4; // pays par appel Gemini

app.post('/api/analyze', async (req, res) => {
  /* Vérifier que Gemini est configuré */
  if (!gemini || !geminiModel) {
    return res.status(503).json({
      error: 'GEMINI_API_KEY non configurée. Ajoutez-la dans les Secrets Replit (clé : GEMINI_API_KEY).',
    });
  }

  const { company = {}, targets = [], objectives = {}, kpis = [], context = '', news = [] } = req.body;

  /* Validation */
  if (!company.sector)     return res.status(400).json({ error: 'Le secteur d\'activité est requis.' });
  if (!targets.length)     return res.status(400).json({ error: 'Au moins un pays cible est requis.' });
  if (targets.length > 50) return res.status(400).json({ error: 'Maximum 50 pays par analyse.' });

  /* Contexte unifié */
  const ctx = {
    name:     company.name || '',
    sector:   company.sector,
    product:  company.product || '',
    revenue:  company.revenue  ? company.revenue + ' €'  : '',
    employees:company.employees || '',
    team:     company.team_size || '',
    budget:   company.budget   ? company.budget + ' €'   : '',
    export_pct:company.export_pct ? company.export_pct + '%' : '',
    active:   Array.isArray(company.active_countries) ? company.active_countries.join(', ') : (company.active_countries || ''),
    goal:     objectives.goal         || '',
    horizon:  objectives.horizon      || '',
    target:   objectives.target_value || '',
    kpis:     (kpis || []).join(', '),
    context:  context || '',
  };

  /* Découpage en batches */
  const batches = [];
  for (let i = 0; i < targets.length; i += BATCH_SIZE) batches.push(targets.slice(i, i + BATCH_SIZE));

  const allCountries = [];
  let finalSummary = '';
  let batchErrors  = 0;

  for (let b = 0; b < batches.length; b++) {
    try {
      const prompt = buildPrompt(ctx, batches[b], news);
      const result = await geminiModel.generateContent(prompt);
      const text   = result.response.text();

      if (!text) throw new Error('Réponse vide de Gemini');

      const parsed = extractJSON(text);
      if (!parsed) throw new Error('JSON avec "countries" introuvable dans la réponse');

      allCountries.push(...parsed.countries);
      if (b === 0) finalSummary = parsed.summary || '';

    } catch (err) {
      console.error(`[ANALYZE] Batch ${b + 1} échoué :`, err.message);
      batchErrors++;

      /* Retry sans news si le prompt était peut-être trop long */
      try {
        const prompt2 = buildPrompt(ctx, batches[b], []);
        const result2 = await geminiModel.generateContent(prompt2);
        const text2   = result2.response.text();
        const parsed2 = extractJSON(text2 || '');
        if (parsed2) {
          allCountries.push(...parsed2.countries);
          batchErrors--; // retry a réussi
          continue;
        }
      } catch (_) {}

      /* Placeholders pour ce batch */
      batches[b].forEach(c => allCountries.push(makePlaceholder(c, err.message)));
    }

    /* Petite pause entre batches pour respecter les quotas Gemini */
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  const successCount = allCountries.filter(c => !c._error).length;

  if (successCount === 0) {
    return res.status(502).json({
      error: 'L\'analyse a échoué pour tous les pays. Vérifiez votre clé GEMINI_API_KEY dans les Secrets Replit.',
      partial: false,
    });
  }

  /* Résumé global si plusieurs batches */
  if (batches.length > 1) {
    const top = allCountries
      .filter(c => !c._error && c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    finalSummary = `Analyse de ${successCount} marchés complétée`
      + (batchErrors > 0 ? ` (${batchErrors * BATCH_SIZE} pays non analysés)` : '') + '. '
      + (top.length ? `Marchés prioritaires : ${top.map(c => c.country + ' (' + Math.round(c.score) + '/100)').join(', ')}.` : '');
  }

  return res.json({
    summary:  finalSummary,
    countries:allCountries,
    total:    allCountries.length,
    analyzed: successCount,
    errors:   batchErrors * BATCH_SIZE,
    partial:  batchErrors > 0,
  });
});

/* ── Servir le frontend ── */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── Erreur globale ── */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[SERVER]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erreur interne du serveur' });
});

/* ── Démarrage ── */
app.listen(PORT, () => {
  console.log(`\n✅  Xpansio démarré → http://localhost:${PORT}`);
  console.log(`   GEMINI_API_KEY    : ${GEMINI_KEY         ? '✓ configurée' : '✗ MANQUANTE — ajoutez dans Secrets'}`);
  console.log(`   NEWS_API_KEY      : ${process.env.NEWS_API_KEY         ? '✓ configurée' : '○ absent (RSS actif)'}`);
  console.log(`   OPENCORPORATES    : ${process.env.OPENCORPORATES_API_KEY ? '✓ configurée' : '○ absent (mode public)'}`);
  console.log('');
  if (!GEMINI_KEY) {
    console.log('  ⚠  Sans GEMINI_API_KEY, l\'analyse ne fonctionnera pas.');
    console.log('     Ajoutez-la dans les Secrets Replit avec la clé : GEMINI_API_KEY\n');
  }
});
